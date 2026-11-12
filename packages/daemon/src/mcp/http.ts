import { randomUUID } from 'node:crypto';
import type { Core } from '@amineeded/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Router, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import type { Scheduler } from '../scheduler.js';
import { actorFromClient, createMcpServer } from './server.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastUsed: number;
}

export interface McpHttpDeps {
  core: Core;
  scheduler: Scheduler;
  version: string;
  logger: Logger;
  idleTimeoutMs?: number;
}

/** Optional header to pin the actor, e.g. when a client's name is not recognizable. */
export const CLIENT_HEADER = 'x-amineeded-client';

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * Streamable HTTP endpoint with stateful sessions. Sessions are needed because the client
 * identifies itself (clientInfo → created_by) only in `initialize`.
 * Host/Origin/token checks happen before this router.
 */
export function mcpRouter(deps: McpHttpDeps): { router: Router; close(): Promise<void> } {
  const sessions = new Map<string, Session>();
  const idleTimeoutMs = deps.idleTimeoutMs ?? 60 * 60 * 1000;

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - idleTimeoutMs;
      for (const [id, s] of sessions) {
        if (s.lastUsed < cutoff) {
          sessions.delete(id);
          void s.transport.close();
        }
      }
    },
    Math.min(idleTimeoutMs, 5 * 60 * 1000),
  );
  sweep.unref();

  const existing = (req: Request): Session | undefined => {
    const id = req.header('mcp-session-id');
    const s = id ? sessions.get(id) : undefined;
    if (s) s.lastUsed = Date.now();
    return s;
  };

  const router = Router();

  router.post('/', async (req, res) => {
    const session = existing(req);
    if (session) return session.transport.handleRequest(req, res, req.body);

    if (req.header('mcp-session-id')) {
      // Unknown/expired session: 404 tells the client to initialize again.
      return jsonRpcError(res, 404, 'Session not found');
    }
    if (!isInitializeRequest(req.body)) {
      return jsonRpcError(res, 400, 'Bad Request: initialize first (no session id)');
    }

    const override = req.header(CLIENT_HEADER);
    // `server` is created below; the callbacks only run once a request is handled.
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastUsed: Date.now() });
        const client = server.server.getClientVersion();
        deps.logger.info({ session: id, client: client?.name }, 'mcp session started');
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server: McpServer = createMcpServer({
      core: deps.core,
      scheduler: deps.scheduler,
      version: deps.version,
      actor: () => actorFromClient(server.server.getClientVersion()?.name, override),
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const sessionOnly = async (req: Request, res: Response) => {
    const session = existing(req);
    if (!session) return jsonRpcError(res, req.header('mcp-session-id') ? 404 : 400, 'No session');
    await session.transport.handleRequest(req, res);
  };
  router.get('/', sessionOnly);
  router.delete('/', sessionOnly);

  return {
    router,
    async close() {
      clearInterval(sweep);
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(all.map((s) => s.transport.close()));
    },
  };
}
