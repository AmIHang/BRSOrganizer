import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SECRET_KEYS, type SecretStore } from '@brsorganizer/core';

const OLD = 'AmINeeded';
const NEW = 'BRSOrganizer';

/** Old name of a data folder or keyring service (`BRSOrganizer-dev` -> `AmINeeded-dev`), else null. */
export function legacyName(name: string): string | null {
  return name.includes(NEW) ? name.replace(NEW, OLD) : null;
}

/**
 * One-time takeover from the app's former name AmINeeded: copies the old database (with its WAL
 * files) and the Credential Manager entries. Never overwrites anything that already exists and
 * never touches the old copies. Returns what was taken over.
 */
export function migrateLegacy(opts: {
  dataDir: string;
  databaseFile: string;
  secrets: SecretStore;
  legacySecrets: SecretStore | null;
}): string[] {
  const taken: string[] = [];
  const oldDirName = legacyName(basename(opts.dataDir));
  const oldDb = oldDirName && join(dirname(opts.dataDir), oldDirName, 'amineeded.db');
  if (oldDb && existsSync(oldDb) && !existsSync(opts.databaseFile)) {
    mkdirSync(dirname(opts.databaseFile), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(oldDb + suffix)) copyFileSync(oldDb + suffix, opts.databaseFile + suffix);
    }
    taken.push('database');
  }
  if (opts.legacySecrets) {
    for (const key of SECRET_KEYS) {
      if (opts.secrets.get(key) !== null) continue;
      const value = opts.legacySecrets.get(key);
      if (value === null) continue;
      opts.secrets.set(key, value);
      taken.push(key);
    }
  }
  return taken;
}
