import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';

// Kept in sync with @amineeded/core (paths.ts, secrets). mcp-stdio talks to the daemon over
// HTTP only and does not depend on core.
export const APP_NAME = 'AmINeeded';
export const DEFAULT_PORT = 47821;
const TOKEN_ACCOUNT = 'local-access-token';

export type Env = Record<string, string | undefined>;

/**
 * `AMINEEDED_DATA_DIR`, else `%LOCALAPPDATA%\AmINeeded`. When started from WSL via interop
 * LOCALAPPDATA may be missing; the Windows profile directory is the fallback.
 */
export function dataDir(env: Env = process.env): string {
  if (env.AMINEEDED_DATA_DIR) return env.AMINEEDED_DATA_DIR;
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, APP_NAME);
  return join(homedir(), 'AppData', 'Local', APP_NAME);
}

export function readDiscoveredPort(env: Env = process.env): number | null {
  try {
    const info = JSON.parse(readFileSync(join(dataDir(env), 'daemon.json'), 'utf8')) as {
      port?: unknown;
    };
    return typeof info.port === 'number' ? info.port : null;
  } catch {
    return null;
  }
}

/** `--port` > `AMINEEDED_PORT` > daemon.json > default. Re-evaluated on every reconnect. */
export function resolvePort(cliPort: string | undefined, env: Env = process.env): number {
  const explicit = cliPort ?? env.AMINEEDED_PORT;
  if (explicit !== undefined) {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${explicit}`);
    return n;
  }
  return readDiscoveredPort(env) ?? DEFAULT_PORT;
}

export function keyringService(env: Env = process.env): string {
  return env.AMINEEDED_KEYRING_SERVICE ?? APP_NAME;
}

/** Local access token from the Windows Credential Manager (written by the daemon). */
export function readToken(env: Env = process.env): string | null {
  try {
    return new Entry(keyringService(env), TOKEN_ACCOUNT).getPassword() ?? null;
  } catch {
    return null;
  }
}

export const CLIENT_NAMES = ['claude', 'copilot', 'other'] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];
