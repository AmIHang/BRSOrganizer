import { createServer } from 'node:net';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHarness, TOKEN, type Harness } from '../../daemon/test/harness.js';
import { startProxy, type ProxyHandle, type ProxyOptions } from '../src/proxy.js';

/** Client-side transport over in-memory streams (what a stdio client does over pipes). */
class StreamClientTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  async start(): Promise<void> {
    this.input.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let m = this.buffer.readMessage(); m; m = this.buffer.readMessage()) {
        this.onmessage?.(m);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.output.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.output.end();
    this.onclose?.();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function text(r: unknown): Record<string, unknown> {
  const c = (r as CallToolResult).content[0];
  if (c?.type !== 'text') throw new Error('expected text');
  return JSON.parse(c.text) as Record<string, unknown>;
}

describe('stdio proxy', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.reverse()) await c().catch(() => undefined);
    cleanups.length = 0;
  });

  async function harness(port?: number): Promise<Harness> {
    const h = await startHarness(port ? { port } : {});
    cleanups.push(() => h.close());
    return h;
  }

  async function connect(
    opts: Partial<ProxyOptions> & Pick<ProxyOptions, 'resolveUpstream'>,
    clientName = 'claude-code',
  ): Promise<{ client: Client; proxy: ProxyHandle; logs: string[] }> {
    const toProxy = new PassThrough();
    const fromProxy = new PassThrough();
    const logs: string[] = [];
    const proxy = await startProxy({
      stdin: toProxy,
      stdout: fromProxy,
      log: (m) => logs.push(m),
      reinitTimeoutMs: 5000,
      ...opts,
    });
    cleanups.push(() => proxy.close());
    const client = new Client({ name: clientName, version: '1.0.0' });
    cleanups.push(() => client.close());
    await client.connect(new StreamClientTransport(fromProxy, toProxy));
    return { client, proxy, logs };
  }

  const upstream =
    (port: number, headers: Record<string, string> = {}) =>
    async () => ({
      url: new URL(`http://127.0.0.1:${port}/mcp`),
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    });

  it('bridges a stdio client to the daemon', async () => {
    const h = await harness();
    const { client } = await connect({ resolveUpstream: upstream(h.port) });

    expect(client.getServerVersion()?.name).toBe('amineeded');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('add_todo');

    const r = text(await client.callTool({ name: 'add_todo', arguments: { title: 'via stdio' } }));
    expect(r.item).toMatchObject({ title: 'via stdio', created_by: 'claude' });
  });

  it('passes the --client override as header', async () => {
    const h = await harness();
    const { client } = await connect(
      { resolveUpstream: upstream(h.port, { 'X-AmINeeded-Client': 'copilot' }) },
      'unknown-agent',
    );
    const r = text(await client.callTool({ name: 'add_todo', arguments: { title: 'x' } }));
    expect(r.item).toMatchObject({ created_by: 'copilot' });
  });

  it('survives a daemon restart by re-initializing transparently', async () => {
    const port = await freePort();
    const first = await harness(port);
    const { client, logs } = await connect({ resolveUpstream: upstream(port) });
    await client.callTool({ name: 'add_todo', arguments: { title: 'before restart' } });

    await first.close();
    const second = await harness(port);
    second.core.items.addTodo({ title: 'after restart' }, 'user');

    const r = text(await client.callTool({ name: 'list_items', arguments: {} }));
    expect((r.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['after restart']);
    expect(logs).toContain('reconnected to the daemon');

    // The client keeps working on the new session.
    const added = text(await client.callTool({ name: 'add_todo', arguments: { title: 'again' } }));
    expect(added.item).toMatchObject({ created_by: 'claude' });
  });

  it('starts the daemon when it is not running', async () => {
    const port = await freePort();
    const onDaemonUnreachable = vi.fn(async () => {
      await harness(port);
    });
    const { client } = await connect({ resolveUpstream: upstream(port), onDaemonUnreachable });
    expect(onDaemonUnreachable).toHaveBeenCalledTimes(1);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('reports a readable error when the daemon stays down', async () => {
    const port = await freePort();
    const onDaemonUnreachable = vi.fn(async () => undefined);
    await expect(connect({ resolveUpstream: upstream(port), onDaemonUnreachable })).rejects.toThrow(
      /daemon is not reachable/,
    );
    expect(onDaemonUnreachable).toHaveBeenCalledTimes(1);
  });

  it('re-reads the token after a 401', async () => {
    const h = await harness();
    const tokens = ['stale-token', TOKEN];
    const resolveUpstream = vi.fn(async () => ({
      url: new URL(`http://127.0.0.1:${h.port}/mcp`),
      headers: { Authorization: `Bearer ${tokens.shift() ?? TOKEN}` },
    }));
    const { client } = await connect({ resolveUpstream });
    expect(resolveUpstream).toHaveBeenCalledTimes(2);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('shuts down when the client disconnects', async () => {
    const h = await harness();
    const { client, proxy } = await connect({ resolveUpstream: upstream(h.port) });
    await client.listTools();
    await client.close();
    await expect(proxy.closed).resolves.toBeUndefined();
  });
});
