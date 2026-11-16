import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@brsorganizer/core';
import { legacyName, migrateLegacy } from '../src/legacy.js';

describe('takeover from AmINeeded', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), 'brsorganizer-legacy-'));
    const oldDir = join(root, 'AmINeeded-dev');
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'amineeded.db'), 'db');
    writeFileSync(join(oldDir, 'amineeded.db-wal'), 'wal');
    const dataDir = join(root, 'BRSOrganizer-dev');
    return { oldDir, dataDir, databaseFile: join(dataDir, 'brsorganizer.db') };
  }

  it('maps the new names to the old ones', () => {
    expect(legacyName('BRSOrganizer')).toBe('AmINeeded');
    expect(legacyName('BRSOrganizer-dev')).toBe('AmINeeded-dev');
    expect(legacyName('custom')).toBeNull();
  });

  it('copies the database and missing credentials once, without overwriting', () => {
    const paths = setup();
    const secrets = new MemorySecretStore({ 'github-token': 'new' });
    const legacySecrets = new MemorySecretStore({ 'github-token': 'old', 'tfs-token': 'pat' });

    expect(migrateLegacy({ ...paths, secrets, legacySecrets })).toEqual(['database', 'tfs-token']);
    expect(readFileSync(paths.databaseFile, 'utf8')).toBe('db');
    expect(readFileSync(paths.databaseFile + '-wal', 'utf8')).toBe('wal');
    expect(existsSync(paths.databaseFile + '-shm')).toBe(false);
    expect(secrets.get('github-token')).toBe('new');
    expect(secrets.get('tfs-token')).toBe('pat');
    expect(existsSync(join(paths.oldDir, 'amineeded.db'))).toBe(true);

    writeFileSync(paths.databaseFile, 'newer');
    expect(migrateLegacy({ ...paths, secrets, legacySecrets })).toEqual([]);
    expect(readFileSync(paths.databaseFile, 'utf8')).toBe('newer');
  });
});
