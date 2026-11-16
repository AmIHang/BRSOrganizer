import type { Core } from '@brsorganizer/core';
import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { errorHandler } from './http/errors.js';
import { restRouter } from './http/rest.js';
import { bearerAuth, hostCheck, originCheck } from './http/security.js';
import { mcpRouter } from './mcp/http.js';
import type { PrWorkspace } from './prs/service.js';
import type { Scheduler } from './scheduler.js';

export interface AppDeps {
  core: Core;
  scheduler: Scheduler;
  logger: Logger;
  /** Local access token clients must send as Bearer. */
  token: string;
  /** Port the server listens on (read per request, so tests can listen on port 0 first). */
  getPort: () => number;
  allowedOrigins: readonly string[];
  version: string;
  onShutdown?: () => void;
  /** PR workspace (clone/open/remove/complete); REST only, never exposed to MCP. */
  prWorkspace?: PrWorkspace;
}

export function createApp(deps: AppDeps): { app: Express; close(): Promise<void> } {
  const app = express();
  app.disable('x-powered-by');

  // Order matters: Host and Origin are checked before anything else, preflights end in originCheck.
  app.use(hostCheck(deps.getPort));
  app.use(originCheck(deps.allowedOrigins));

  // Unauthenticated liveness probe, so clients can tell "our daemon" from "port taken".
  app.get('/health', (_req, res) => {
    res.json({ ok: true, app: 'BRSOrganizer', version: deps.version });
  });

  app.use(bearerAuth(deps.token));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', restRouter(deps));
  const mcp = mcpRouter(deps);
  app.use('/mcp', mcp.router);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler(deps.logger));

  return { app, close: mcp.close };
}
