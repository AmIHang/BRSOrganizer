import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseOptions {
  /** File path or `:memory:`. */
  file: string;
  /** Folder with the Drizzle SQL migrations. Defaults to `packages/core/drizzle`. */
  migrationsFolder?: string;
}

export interface DatabaseHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/** Resolves to `<package>/drizzle` from both `src/db` (tests) and `dist/db` (build). */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  if (options.file !== ':memory:') {
    mkdirSync(dirname(options.file), { recursive: true });
  }
  const sqlite = new Database(options.file);
  // WAL lets the UI read while a sync writes; busy_timeout covers the rare writer overlap.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER });

  return { db, sqlite, close: () => sqlite.close() };
}
