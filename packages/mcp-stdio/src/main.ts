#!/usr/bin/env node
/**
 * stdio ↔ Streamable HTTP bridge for MCP clients that only speak stdio, and the recommended
 * way to connect any client: the access token is read from the Windows Credential Manager,
 * so it never ends up in a client's config file.
 *
 * stdout carries the protocol; all diagnostics go to stderr.
 */
import { parseArgs } from 'node:util';
import { CLIENT_NAMES, readToken, resolvePort, type ClientName } from './config.js';
import { defaultDaemonMain, startDaemon } from './launcher.js';
import { startProxy } from './proxy.js';

const log = (m: string) => process.stderr.write(`[brsorganizer-mcp] ${m}\n`);

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    client: { type: 'string' },
    'no-start-daemon': { type: 'boolean', default: false },
    'daemon-main': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  process.stderr.write(`brsorganizer-mcp – stdio MCP bridge to the BRSOrganizer daemon

Options:
  --client claude|copilot|other  Who is creating items (default: derived from the client's name)
  --port <n>                     Daemon port (default: BRSORGANIZER_PORT, daemon.json, 47821)
  --no-start-daemon              Do not start the daemon if it is not running
  --daemon-main <path>           Daemon entry point to start (default: monorepo build)
`);
  process.exit(0);
}

const client = args.client?.toLowerCase();
if (client !== undefined && !CLIENT_NAMES.includes(client as ClientName)) {
  log(`invalid --client ${args.client}; expected ${CLIENT_NAMES.join(', ')}`);
  process.exit(2);
}

const daemonMain = args['no-start-daemon'] ? null : (args['daemon-main'] ?? defaultDaemonMain());

async function ensureDaemon(): Promise<void> {
  if (!daemonMain) return;
  await startDaemon({ daemonMain, port: resolvePort(args.port), log });
}

const proxy = await startProxy({
  stdin: process.stdin,
  stdout: process.stdout,
  log,
  onDaemonUnreachable: ensureDaemon,
  async resolveUpstream() {
    const port = resolvePort(args.port);
    let token = readToken();
    if (!token) {
      // The daemon creates the token on its first start.
      await ensureDaemon();
      token = readToken();
    }
    if (!token) {
      throw new Error(
        'no BRSOrganizer access token in the Credential Manager – start the BRSOrganizer app once',
      );
    }
    return {
      url: new URL(`http://127.0.0.1:${port}/mcp`),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(client && { 'X-BRSOrganizer-Client': client }),
      },
    };
  },
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(signal, () => void proxy.close());
}
await proxy.closed;
// Let pending handles close on their own: an immediate process.exit() while libuv is still
// closing handles trips an assertion on Windows. The timer is only a safety net.
process.exitCode = 0;
setTimeout(() => process.exit(0), 2000).unref();
