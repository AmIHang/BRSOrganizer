import type { Readable, Writable } from 'node:stream';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';

export interface Upstream {
  url: URL;
  headers: Record<string, string>;
}

export interface ProxyOptions {
  stdin: Readable;
  stdout: Writable;
  /** Called for every (re)connect, so a changed port or token is picked up. */
  resolveUpstream: () => Promise<Upstream>;
  /** Called when the daemon cannot be reached; may start it. */
  onDaemonUnreachable?: () => Promise<void>;
  log: (message: string) => void;
  reinitTimeoutMs?: number;
}

export interface ProxyHandle {
  /** Resolves when the downstream client disconnected and the proxy shut down. */
  closed: Promise<void>;
  close(): Promise<void>;
}

type FailureKind = 'network' | 'session' | 'auth' | 'other';

function classify(e: unknown): FailureKind {
  if (e instanceof StreamableHTTPError) {
    if (e.code === 404) return 'session';
    if (e.code === 401) return 'auth';
    return 'other';
  }
  if (e instanceof TypeError || (e as { cause?: { code?: string } })?.cause?.code) return 'network';
  return 'other';
}

function describe(e: unknown, kind: FailureKind): string {
  switch (kind) {
    case 'network':
      return 'AmINeeded daemon is not reachable. Start the AmINeeded app (or the daemon) and retry.';
    case 'auth':
      return 'AmINeeded daemon rejected the access token (Credential Manager entry out of date?).';
    case 'session':
      return 'AmINeeded MCP session expired and could not be re-established.';
    default:
      return `AmINeeded proxy error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Bridges a stdio MCP client to the daemon's Streamable HTTP endpoint, message by message.
 * If the daemon restarts (session 404), changes its token (401) or is down (network error),
 * the proxy reconnects, replays the client's `initialize` and retries the message once, so
 * the client keeps its session.
 */
class McpProxy {
  private readonly downstream: StdioServerTransport;
  private upstream: StreamableHTTPClientTransport | null = null;
  private initRequest: JSONRPCRequest | null = null;
  private readonly pendingReinit = new Map<string, (msg: JSONRPCMessage) => void>();
  private reinitSeq = 0;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((r) => (this.resolveClosed = r));

  constructor(private readonly opts: ProxyOptions) {
    this.downstream = new StdioServerTransport(opts.stdin, opts.stdout);
    this.downstream.onmessage = (msg) => {
      // Keep client order; a send resolves once the HTTP request is accepted, not when the
      // (streamed) response is complete, so long tool calls do not block others.
      this.queue = this.queue.then(() => this.forward(msg));
    };
    this.downstream.onerror = (e) => opts.log(`stdio error: ${e.message}`);
    this.downstream.onclose = () => void this.close();
    // StdioServerTransport does not notice EOF; without this the open upstream SSE stream
    // keeps the process alive after the client exits.
    opts.stdin.once('end', () => void this.close());
    opts.stdin.once('close', () => void this.close());
  }

  start(): Promise<void> {
    return this.downstream.start();
  }

  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    const up = this.upstream;
    this.upstream = null;
    if (up) {
      // End the server-side session (best effort), then drop the connection.
      await Promise.race([up.terminateSession(), new Promise((r) => setTimeout(r, 2000))]).catch(
        () => undefined,
      );
      await up.close().catch(() => undefined);
    }
    await this.downstream.close().catch(() => undefined);
    this.resolveClosed();
  }

  private async forward(msg: JSONRPCMessage): Promise<void> {
    if (this.closing) return;
    if (isJSONRPCRequest(msg) && msg.method === 'initialize') this.initRequest = msg;

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await this.recover(lastError, msg);
        await (await this.connect()).send(msg);
        return;
      } catch (e) {
        lastError = e;
        if (classify(e) === 'other') break;
        this.opts.log(
          `upstream ${classify(e)} failure, ${attempt === 0 ? 'retrying' : 'giving up'}`,
        );
      }
    }
    this.replyError(msg, lastError);
  }

  private async recover(error: unknown, msg: JSONRPCMessage): Promise<void> {
    if (classify(error) === 'network') await this.opts.onDaemonUnreachable?.();
    await this.dropUpstream();
    // A fresh daemon session needs the handshake before anything else.
    if (this.initRequest && msg !== this.initRequest) await this.reinitialize();
  }

  private async connect(): Promise<StreamableHTTPClientTransport> {
    if (this.upstream) return this.upstream;
    const { url, headers } = await this.opts.resolveUpstream();
    const t = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    t.onmessage = (m) => this.fromUpstream(t, m);
    t.onerror = (e) => this.opts.log(`upstream: ${e.message}`);
    await t.start();
    this.upstream = t;
    return t;
  }

  private async dropUpstream(): Promise<void> {
    const old = this.upstream;
    this.upstream = null;
    if (old) {
      old.onmessage = undefined;
      await old.close().catch(() => undefined);
    }
  }

  private async reinitialize(): Promise<void> {
    const t = await this.connect();
    const id = `amineeded-proxy-reinit-${++this.reinitSeq}`;
    const response = new Promise<JSONRPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReinit.delete(id);
        reject(new Error('re-initialize timed out'));
      }, this.opts.reinitTimeoutMs ?? 15_000);
      this.pendingReinit.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    await t.send({ ...this.initRequest!, id });
    const res = await response;
    if (!isJSONRPCResultResponse(res)) throw new Error('re-initialize was rejected by the daemon');
    const version = (res.result as { protocolVersion?: string }).protocolVersion;
    if (version) t.setProtocolVersion(version);
    await t.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.opts.log('reconnected to the daemon');
  }

  private fromUpstream(t: StreamableHTTPClientTransport, msg: JSONRPCMessage): void {
    if ((isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) && msg.id !== undefined) {
      const pending = this.pendingReinit.get(String(msg.id));
      if (pending) {
        this.pendingReinit.delete(String(msg.id));
        pending(msg);
        return;
      }
      if (isJSONRPCResultResponse(msg) && this.initRequest && msg.id === this.initRequest.id) {
        const version = (msg.result as { protocolVersion?: string }).protocolVersion;
        if (version) t.setProtocolVersion(version);
      }
    }
    this.downstream.send(msg).catch((e: Error) => this.opts.log(`stdout: ${e.message}`));
  }

  private replyError(msg: JSONRPCMessage, error: unknown): void {
    const kind = classify(error);
    this.opts.log(`dropping message: ${error instanceof Error ? error.message : String(error)}`);
    if (!isJSONRPCRequest(msg)) return;
    void this.downstream
      .send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: describe(error, kind) },
      })
      .catch(() => undefined);
  }
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const proxy = new McpProxy(opts);
  await proxy.start();
  return { closed: proxy.closed, close: () => proxy.close() };
}
