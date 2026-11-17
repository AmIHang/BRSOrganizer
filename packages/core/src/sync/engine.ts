import { and, eq, lte, max } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import {
  items,
  syncRuns,
  type ExternalSource,
  type ItemMeta,
  type ItemRow,
  type NewItemRow,
  type SyncRunRow,
} from '../db/schema.js';
import type { CoreEvents } from '../events.js';

/** One item as reported by an external source. */
export interface ExternalItem {
  /** Stable ID within the source; together with the source it is the dedup key. */
  externalId: string;
  type: 'pr' | 'event';
  title: string;
  notes?: string | null;
  link?: string | null;
  dueAt?: Date | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  meta?: ItemMeta | null;
}

export interface SyncSource {
  readonly id: ExternalSource;
  /**
   * Returns the COMPLETE current set of items that need attention. Must throw rather than
   * return a partial list: anything missing from the snapshot gets closed.
   */
  fetchSnapshot(): Promise<ExternalItem[]>;
}

export interface SyncCounts {
  added: number;
  updated: number;
  closed: number;
  reopened: number;
  unchanged: number;
}

export interface SyncResult extends SyncCounts {
  source: ExternalSource;
  ok: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string;
  addedIds: string[];
}

const MAX_TITLE = 500;
const MAX_NOTES = 10_000;
const KEEP_SYNC_RUNS = 500;

export class SyncEngine {
  private readonly inFlight = new Map<ExternalSource, Promise<SyncResult>>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly events: CoreEvents,
  ) {}

  /** Fetches and applies a snapshot. Concurrent calls for the same source share one run. */
  run(source: SyncSource): Promise<SyncResult> {
    const running = this.inFlight.get(source.id);
    if (running) return running;
    const p = this.runOnce(source).finally(() => this.inFlight.delete(source.id));
    this.inFlight.set(source.id, p);
    return p;
  }

  async runAll(sources: SyncSource[]): Promise<SyncResult[]> {
    return Promise.all(sources.map((s) => this.run(s)));
  }

  lastRuns(limit = 20): SyncRunRow[] {
    return this.db.select().from(syncRuns).orderBy(syncRuns.id).all().slice(-limit).reverse();
  }

  private async runOnce(source: SyncSource): Promise<SyncResult> {
    const startedAt = this.clock.now();
    const runId = this.db
      .insert(syncRuns)
      .values({ source: source.id, startedAt })
      .returning({ id: syncRuns.id })
      .get().id;

    let counts: SyncCounts & { addedIds: string[]; changedIds: string[] };
    let error: string | null = null;
    try {
      const snapshot = await source.fetchSnapshot();
      counts = this.apply(source.id, snapshot);
      counts.changedIds.push(...this.adoptAgentTodos());
    } catch (e) {
      // Nothing is closed on failure: a failed fetch must not look like "everything is gone".
      error = describeError(e);
      counts = {
        added: 0,
        updated: 0,
        closed: 0,
        reopened: 0,
        unchanged: 0,
        addedIds: [],
        changedIds: [],
      };
    }

    const finishedAt = this.clock.now();
    this.db
      .update(syncRuns)
      .set({
        finishedAt,
        ok: error === null,
        error,
        added: counts.added,
        updated: counts.updated,
        closed: counts.closed,
        reopened: counts.reopened,
      })
      .where(eq(syncRuns.id, runId))
      .run();
    this.pruneRuns();

    const result: SyncResult = {
      source: source.id,
      ok: error === null,
      error,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      added: counts.added,
      updated: counts.updated,
      closed: counts.closed,
      reopened: counts.reopened,
      unchanged: counts.unchanged,
      addedIds: counts.addedIds,
    };

    if (counts.changedIds.length) {
      this.events.emit('items-changed', { reason: 'sync', actor: 'sync', ids: counts.changedIds });
    }
    if (counts.addedIds.length) {
      this.events.emit('items-added-by-sync', { source: source.id, ids: counts.addedIds });
    }
    this.events.emit('sync-finished', result);
    return result;
  }

  /**
   * A todo handed to an agent (`meta.agentBranch`) becomes its pull request once the PR shows
   * up: the PR takes over the todo's tickets (unless it has its own) and the todo is done.
   * The branch is dropped from the todo, so reopening it does not adopt the PR again.
   */
  adoptAgentTodos(): string[] {
    const open = (type: 'todo' | 'pr') =>
      this.db
        .select()
        .from(items)
        .where(and(eq(items.type, type), eq(items.status, 'open')))
        .all();
    const todos = open('todo').filter((t) => typeof t.meta?.agentBranch === 'string');
    if (!todos.length) return [];
    const prs = open('pr');
    const changed: string[] = [];
    const now = this.clock.now();

    this.db.transaction((tx) => {
      for (const todo of todos) {
        const branch = String(todo.meta!.agentBranch).toLowerCase();
        // The agent renames its branch after its change but keeps the todo's id suffix.
        const suffix = `-${todo.id.slice(-6).toLowerCase()}`;
        const project = todo.meta!.project;
        const pr = prs.find((p) => {
          const source =
            typeof p.meta?.sourceBranch === 'string' ? p.meta.sourceBranch.toLowerCase() : null;
          return (
            source !== null &&
            (source === branch || source.endsWith(suffix)) &&
            (typeof project !== 'string' || p.meta?.project === project)
          );
        });
        if (!pr) continue;
        tx.update(items)
          .set({
            bsmUrl: pr.bsmUrl ?? todo.bsmUrl,
            otmaUrl: pr.otmaUrl ?? todo.otmaUrl,
            updatedBy: 'sync',
            updatedAt: now,
          })
          .where(eq(items.id, pr.id))
          .run();
        const meta: ItemMeta = { ...todo.meta, prItemId: pr.id };
        delete meta.agentBranch;
        tx.update(items)
          .set({
            status: 'done',
            statusChangedBy: 'sync',
            completedAt: now,
            meta,
            updatedBy: 'sync',
            updatedAt: now,
          })
          .where(eq(items.id, todo.id))
          .run();
        changed.push(pr.id, todo.id);
      }
    });
    return changed;
  }

  /**
   * Applies a complete snapshot in one transaction. Idempotent: applying the same snapshot
   * twice changes nothing the second time (except `last_seen_at`).
   */
  apply(
    source: ExternalSource,
    snapshot: ExternalItem[],
  ): SyncCounts & { addedIds: string[]; changedIds: string[] } {
    const now = this.clock.now();
    const incoming = new Map<string, ExternalItem>();
    for (const item of snapshot) incoming.set(item.externalId, normalize(item));

    const counts = { added: 0, updated: 0, closed: 0, reopened: 0, unchanged: 0 };
    const addedIds: string[] = [];
    const changedIds: string[] = [];

    this.db.transaction((tx) => {
      const existing = new Map<string, ItemRow>();
      for (const row of tx.select().from(items).where(eq(items.source, source)).all()) {
        if (row.externalId !== null) existing.set(row.externalId, row);
      }

      for (const ext of incoming.values()) {
        const row = existing.get(ext.externalId);
        if (!row) {
          const values: NewItemRow = {
            id: ulid(now.getTime()),
            source,
            externalId: ext.externalId,
            ...fieldsOf(ext),
            status: 'open',
            createdBy: 'sync',
            updatedBy: 'sync',
            statusChangedBy: 'sync',
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
          };
          tx.insert(items).values(values).run();
          counts.added++;
          addedIds.push(values.id);
          changedIds.push(values.id);
          continue;
        }

        const fields = fieldsOf(ext);
        const changed = differs(row, fields);
        // Reopen only what the sync itself closed; user decisions (archived, done) stick.
        const reopen = row.status === 'done' && row.statusChangedBy === 'sync';

        tx.update(items)
          .set({
            lastSeenAt: now,
            ...(changed && { ...fields, updatedBy: 'sync' as const, updatedAt: now }),
            ...(reopen && {
              status: 'open' as const,
              statusChangedBy: 'sync' as const,
              completedAt: null,
              updatedBy: 'sync' as const,
              updatedAt: now,
            }),
          })
          .where(eq(items.id, row.id))
          .run();

        if (reopen) counts.reopened++;
        if (changed) counts.updated++;
        if (reopen || changed) changedIds.push(row.id);
        else counts.unchanged++;
      }

      for (const row of existing.values()) {
        if (row.status !== 'open' || incoming.has(row.externalId!)) continue;
        tx.update(items)
          .set({
            status: 'done',
            statusChangedBy: 'sync',
            updatedBy: 'sync',
            updatedAt: now,
            completedAt: now,
          })
          .where(eq(items.id, row.id))
          .run();
        counts.closed++;
        changedIds.push(row.id);
      }
    });

    return { ...counts, addedIds, changedIds };
  }

  private pruneRuns(): void {
    const latest = this.db
      .select({ id: max(syncRuns.id) })
      .from(syncRuns)
      .get()?.id;
    if (latest && latest > KEEP_SYNC_RUNS) {
      this.db
        .delete(syncRuns)
        .where(lte(syncRuns.id, latest - KEEP_SYNC_RUNS))
        .run();
    }
  }
}

type SyncedFields = Pick<
  NewItemRow,
  'type' | 'title' | 'notes' | 'link' | 'dueAt' | 'startsAt' | 'endsAt' | 'meta'
>;

function fieldsOf(ext: ExternalItem): Required<SyncedFields> {
  return {
    type: ext.type,
    title: ext.title,
    notes: ext.notes ?? null,
    link: ext.link ?? null,
    dueAt: ext.dueAt ?? null,
    startsAt: ext.startsAt ?? null,
    endsAt: ext.endsAt ?? null,
    meta: ext.meta ?? null,
  };
}

function normalize(ext: ExternalItem): ExternalItem {
  const title = ext.title.trim() || '(untitled)';
  return {
    ...ext,
    title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
    notes: ext.notes ? ext.notes.slice(0, MAX_NOTES) : null,
  };
}

const time = (d: Date | null | undefined) => (d ? d.getTime() : null);

function differs(row: ItemRow, f: Required<SyncedFields>): boolean {
  return (
    row.type !== f.type ||
    row.title !== f.title ||
    row.notes !== f.notes ||
    row.link !== f.link ||
    time(row.dueAt) !== time(f.dueAt) ||
    time(row.startsAt) !== time(f.startsAt) ||
    time(row.endsAt) !== time(f.endsAt) ||
    stableJson(row.meta) !== stableJson(f.meta)
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 500);
}
