import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, dataDir, readDiscoveredPort, resolvePort } from '../src/config.js';

describe('config', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amineeded-stdio-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the data dir like the daemon, with a fallback for WSL interop', () => {
    expect(dataDir({ AMINEEDED_DATA_DIR: dir })).toBe(dir);
    expect(dataDir({ LOCALAPPDATA: 'C:\\L' })).toBe(join('C:\\L', 'AmINeeded'));
    expect(dataDir({})).toBe(join(homedir(), 'AppData', 'Local', 'AmINeeded'));
  });

  it('resolves the port: flag > env > daemon.json > default', () => {
    const env = { AMINEEDED_DATA_DIR: dir };
    expect(resolvePort(undefined, env)).toBe(DEFAULT_PORT);

    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ pid: 1, port: 48123 }));
    expect(readDiscoveredPort(env)).toBe(48123);
    expect(resolvePort(undefined, env)).toBe(48123);
    expect(resolvePort(undefined, { ...env, AMINEEDED_PORT: '48200' })).toBe(48200);
    expect(resolvePort('48300', { ...env, AMINEEDED_PORT: '48200' })).toBe(48300);
    expect(() => resolvePort('nope', env)).toThrow(/invalid port/);
  });

  it('ignores a broken daemon.json', () => {
    writeFileSync(join(dir, 'daemon.json'), '{broken');
    expect(resolvePort(undefined, { AMINEEDED_DATA_DIR: dir })).toBe(DEFAULT_PORT);
  });
});
