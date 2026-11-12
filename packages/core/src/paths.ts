import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'AmINeeded';

/**
 * Data directory: `AMINEEDED_DATA_DIR`, else `%LOCALAPPDATA%\AmINeeded` on Windows.
 * Non-Windows fallback exists only for development; the daemon is meant to run on Windows
 * so the DB never lives in the WSL file system.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AMINEEDED_DATA_DIR) return env.AMINEEDED_DATA_DIR;
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, APP_NAME);
  return join(homedir(), '.local', 'share', APP_NAME);
}

export function databaseFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'amineeded.db');
}
