import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'BRSOrganizer';

/**
 * Data directory: `BRSORGANIZER_DATA_DIR`, else `%LOCALAPPDATA%\BRSOrganizer` on Windows.
 * Non-Windows fallback exists only for development; the daemon is meant to run on Windows
 * so the DB never lives in the WSL file system.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRSORGANIZER_DATA_DIR) return env.BRSORGANIZER_DATA_DIR;
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, APP_NAME);
  return join(homedir(), '.local', 'share', APP_NAME);
}

export function databaseFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'brsorganizer.db');
}
