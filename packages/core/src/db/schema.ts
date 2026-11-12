import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const ITEM_TYPES = ['todo', 'pr', 'event'] as const;
export const ITEM_STATUSES = ['open', 'done', 'archived'] as const;
export const ITEM_SOURCES = ['manual', 'github', 'calendar'] as const;
export const ACTORS = ['user', 'claude', 'copilot', 'other', 'sync'] as const;

export type ItemType = (typeof ITEM_TYPES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemSource = (typeof ITEM_SOURCES)[number];
export type Actor = (typeof ACTORS)[number];
export type ExternalSource = Exclude<ItemSource, 'manual'>;

export type ItemMeta = Record<string, unknown>;

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ITEM_TYPES }).notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    link: text('link'),
    /** Deadline (todos). */
    dueAt: integer('due_at', { mode: 'timestamp_ms' }),
    /** Start/end (events). */
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ITEM_STATUSES }).notNull().default('open'),
    source: text('source', { enum: ITEM_SOURCES }).notNull(),
    externalId: text('external_id'),
    /** Source-specific details (repo, review state, location, ...). */
    meta: text('meta', { mode: 'json' }).$type<ItemMeta>(),
    createdBy: text('created_by', { enum: ACTORS }).notNull(),
    updatedBy: text('updated_by', { enum: ACTORS }).notNull(),
    statusChangedBy: text('status_changed_by', { enum: ACTORS }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    /** Last time a sync snapshot contained this item. */
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    // NULL external_ids (manual items) do not collide in SQLite unique indexes.
    uniqueIndex('items_source_external_id_uq').on(t.source, t.externalId),
    index('items_status_idx').on(t.status),
    index('items_due_at_idx').on(t.dueAt),
    index('items_starts_at_idx').on(t.startsAt),
  ],
);

export const syncRuns = sqliteTable('sync_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source', { enum: ['github', 'calendar'] }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  ok: integer('ok', { mode: 'boolean' }).notNull().default(false),
  added: integer('added').notNull().default(0),
  updated: integer('updated').notNull().default(0),
  closed: integer('closed').notNull().default(0),
  reopened: integer('reopened').notNull().default(0),
  error: text('error'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;
export type SyncRunRow = typeof syncRuns.$inferSelect;
