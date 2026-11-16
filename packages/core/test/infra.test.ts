import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { dataDir, databaseFile } from '../src/paths.js';
import { getOrCreateAccessToken, MemorySecretStore } from '../src/secrets/store.js';
import { ValidationError } from '../src/errors.js';
import { makeCore } from './helpers.js';

describe('database', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('opens a file database in WAL mode and runs migrations', () => {
    dir = mkdtempSync(join(tmpdir(), 'brsorganizer-'));
    const handle = openDatabase({ file: join(dir, 'nested', 'test.db') });
    try {
      expect(handle.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      const tables = handle.sqlite
        .prepare("select name from sqlite_master where type='table' order by name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining(['items', 'settings', 'sync_runs']));
    } finally {
      handle.close();
    }
  });

  it('lets a second connection open the same file while the first holds it', () => {
    dir = mkdtempSync(join(tmpdir(), 'brsorganizer-'));
    const file = join(dir, 'race.db');
    const first = openDatabase({ file });
    try {
      // Two daemons starting at once both run the WAL pragma and the migrations.
      const second = openDatabase({ file });
      expect(second.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
      second.close();
    } finally {
      first.close();
    }
  });

  it('can be reopened (migrations are applied once)', () => {
    dir = mkdtempSync(join(tmpdir(), 'brsorganizer-'));
    const file = join(dir, 'test.db');
    openDatabase({ file }).close();
    expect(() => openDatabase({ file }).close()).not.toThrow();
  });
});

describe('paths', () => {
  it('uses %LOCALAPPDATA%\\BRSOrganizer by default and honours the override', () => {
    expect(dataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      join('C:\\Users\\x\\AppData\\Local', 'BRSOrganizer'),
    );
    expect(dataDir({ BRSORGANIZER_DATA_DIR: 'D:\\data', LOCALAPPDATA: 'C:\\x' })).toBe('D:\\data');
    expect(databaseFile({ BRSORGANIZER_DATA_DIR: 'D:\\data' })).toBe(join('D:\\data', 'brsorganizer.db'));
  });
});

describe('secrets', () => {
  it('creates the local access token once and reuses it', () => {
    const store = new MemorySecretStore();
    const a = getOrCreateAccessToken(store);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getOrCreateAccessToken(store)).toBe(a);
  });
});

describe('settings', () => {
  it('returns defaults, merges patches and validates', () => {
    const core = makeCore();
    try {
      expect(core.settings.get()).toEqual({
        syncIntervalMinutes: 5,
        daemonPort: 47821,
        github: { enabled: true, includeAuthored: true, includeAssigned: true },
        calendar: { enabled: true, provider: 'ics', lookAheadDays: 14 },
        tfs: { enabled: true, collectionUrl: '', includeAuthored: true },
        workspace: { projectsRoot: '' },
        mail: { enabled: false, outlookFolder: 'Posteingang/PR', lookBackDays: 90 },
      });
      expect(() => core.settings.update({ tfs: { collectionUrl: 'not a url' } })).toThrow(
        ValidationError,
      );
      expect(() => core.settings.update({ mail: { outlookFolder: '' } })).toThrow(ValidationError);
      core.settings.update({ syncIntervalMinutes: 10, calendar: { lookAheadDays: 7 } });
      expect(core.settings.get()).toMatchObject({
        syncIntervalMinutes: 10,
        calendar: { enabled: true, lookAheadDays: 7 },
      });
      expect(() => core.settings.update({ syncIntervalMinutes: 0 })).toThrow(ValidationError);
      expect(core.settings.get().syncIntervalMinutes).toBe(10);
    } finally {
      core.close();
    }
  });
});
