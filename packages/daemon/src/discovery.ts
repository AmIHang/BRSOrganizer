import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@brsorganizer/core';

/**
 * `%LOCALAPPDATA%\BRSOrganizer\daemon.json` tells local clients (app, mcp-stdio) where the
 * daemon listens. It holds no secrets; the access token stays in the Credential Manager.
 */
export interface DiscoveryInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

export const discoveryFile = () => join(dataDir(), 'daemon.json');

export function writeDiscovery(info: DiscoveryInfo): void {
  writeFileSync(discoveryFile(), JSON.stringify(info, null, 2), 'utf8');
}

export function removeDiscovery(pid: number): void {
  try {
    const current = JSON.parse(readFileSync(discoveryFile(), 'utf8')) as DiscoveryInfo;
    if (current.pid === pid) rmSync(discoveryFile(), { force: true });
  } catch {
    // missing or unreadable: nothing to clean up
  }
}
