#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  APP_NAME,
  createCore,
  databaseFile,
  dataDir,
  getOrCreateAccessToken,
  KeyringSecretStore,
} from '@brsorganizer/core';
import { pino } from 'pino';
import { createApp } from './app.js';
import { removeDiscovery, writeDiscovery } from './discovery.js';
import { DEFAULT_ALLOWED_ORIGINS } from './http/security.js';
import { applyFirstRunDefaults } from './first-run.js';
import { legacyName, migrateLegacy } from './legacy.js';
import { createWindowsLauncher } from './prs/launcher.js';
import { PrWorkspace } from './prs/service.js';
import { edgeTicketSessions } from './tickets/edge.js';
import { linkTickets } from './tickets/link.js';
import { mapProjects } from './tickets/project.js';
import { cleanUpLeftItems } from './prs/cleanup.js';
import { claudeAgentsCli, watchAgents } from './prs/agents.js';
import { createScheduler } from './scheduler.js';
import { updateChecker } from './update.js';
import { VERSION } from './version.js';

const HOST = '127.0.0.1';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    'migrations-dir': { type: 'string' },
    'log-level': { type: 'string', default: 'info' },
    'no-sync': { type: 'boolean', default: false },
  },
});

if (args['data-dir']) process.env.BRSORGANIZER_DATA_DIR = args['data-dir'];
mkdirSync(join(dataDir(), 'logs'), { recursive: true });

const logger = pino(
  {
    name: 'brsorganizer-daemon',
    level: args['log-level'],
    redact: ['*.authorization', '*.token', '*.value'],
  },
  pino.multistream([
    { stream: process.stdout },
    // Opened synchronously: an async open races with early process.exit() (exit code 1).
    { stream: pino.destination({ dest: join(dataDir(), 'logs', 'daemon.log'), sync: true }) },
  ]),
);

// Separate keyring namespace for development (BRSORGANIZER_KEYRING_SERVICE=BRSOrganizer-dev).
const keyringService = process.env.BRSORGANIZER_KEYRING_SERVICE ?? APP_NAME;
const secrets = new KeyringSecretStore(keyringService);
try {
  const legacyService = legacyName(keyringService);
  const taken = migrateLegacy({
    dataDir: dataDir(),
    databaseFile: databaseFile(),
    secrets,
    legacySecrets: legacyService ? new KeyringSecretStore(legacyService) : null,
  });
  if (taken.length) logger.info({ taken }, 'took over data from AmINeeded');
} catch (err) {
  logger.warn({ err }, 'could not take over data from AmINeeded');
}
// Bundled runtime (app install): migrations ship in ./drizzle next to daemon.mjs.
const bundledMigrations = join(dirname(fileURLToPath(import.meta.url)), 'drizzle');
const migrationsFolder =
  args['migrations-dir'] ?? (existsSync(bundledMigrations) ? bundledMigrations : undefined);
const core = createCore({
  databaseFile: databaseFile(),
  secrets,
  ...(migrationsFolder && { migrationsFolder }),
});

try {
  const detected = applyFirstRunDefaults(core);
  if (Object.keys(detected).length)
    logger.info({ detected }, 'first run: applied detected defaults');
} catch (err) {
  logger.warn({ err }, 'first run: could not detect defaults');
}

const port = Number(args.port ?? process.env.BRSORGANIZER_PORT ?? core.settings.get().daemonPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  logger.fatal({ port }, 'invalid port');
  process.exit(1);
}

const allowedOrigins = [
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.BRSORGANIZER_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
];

const token = getOrCreateAccessToken(secrets);
const scheduler = createScheduler({ core, logger });

// PR scripts: runtime\scripts\pr next to daemon.mjs (app install) or packages\daemon\scripts\pr (repo).
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir =
  [join(here, 'scripts', 'pr'), join(here, '..', 'scripts', 'pr')].find((d) =>
    existsSync(join(d, 'Clone-Branch.ps1')),
  ) ?? null;
if (!scriptsDir) logger.warn('PR scripts not found; clone/remove actions are unavailable');
// Own Edge profile in the data folder (dev and installed app each have their own login).
const tickets = edgeTicketSessions({
  profileDir: join(dataDir(), 'edge-profile'),
  log: (msg, extra) => logger.info(extra ?? {}, msg),
  account: () => {
    const user = core.secrets.get('ticket-user');
    const password = core.secrets.get('ticket-password');
    return user && password ? { user, password } : null;
  },
});
// Answers of background agents (claude --bg) go on their todos; their pushes update the PRs.
const agents = watchAgents(core, {
  list: claudeAgentsCli(),
  log: (msg, extra) => logger.warn(extra ?? {}, msg),
  onPrChanged: () => {
    // The app re-reads the clone states after the sync; they must not come from the cache.
    prWorkspace.invalidateCloneSync();
    if (!args['no-sync']) {
      scheduler.runNow().catch((err: unknown) => logger.error({ err }, 'agent sync crashed'));
    }
  },
});
const prWorkspace = new PrWorkspace({
  core,
  launcher: createWindowsLauncher((err) => logger.error({ err }, 'could not start script window')),
  scriptsDir,
  ...tickets,
  tasksDir: join(dataDir(), 'agent-tasks'),
  onAgentOpened: () => agents.soon(),
});
linkTickets(core, tickets, (msg, extra) => logger.warn(extra ?? {}, msg));
mapProjects(core);
cleanUpLeftItems(core, prWorkspace, (msg, extra) => logger.info(extra ?? {}, msg));
const { app, close: closeApp } = createApp({
  core,
  scheduler,
  logger,
  token,
  getPort: () => port,
  allowedOrigins,
  version: VERSION,
  checkUpdate: updateChecker(VERSION),
  onShutdown: () => void shutdown('api'),
  prWorkspace,
  bsm: tickets.bsm,
  otma: tickets.otma,
});

const server = createServer(app);

server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') {
    logger.fatal({ err }, 'server error');
    process.exit(1);
  }
  // Single instance: if our own daemon already answers, exit quietly.
  try {
    const res = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { app?: string };
    if (body.app === 'BRSOrganizer') {
      logger.info({ port }, 'daemon already running, exiting');
      core.close();
      process.exit(0);
    }
  } catch {
    // not ours or not answering
  }
  logger.fatal({ port }, 'port is used by another program; set another port with --port');
  process.exit(1);
});

server.listen(port, HOST, () => {
  writeDiscovery({ pid: process.pid, port, version: VERSION, startedAt: new Date().toISOString() });
  logger.info({ port, dataDir: dataDir(), sources: core.sourceStatus() }, 'daemon listening');
  if (!args['no-sync']) scheduler.start();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 5_000).unref();
  scheduler.stop();
  await closeApp();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  removeDiscovery(process.pid);
  core.close();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(signal, () => void shutdown(signal));
}
