import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { items, type Actor, type ItemRow, type ItemStatus } from '../db/schema.js';
import { ForbiddenOperationError, NotFoundError, ValidationError } from '../errors.js';
import type { CoreEvents } from '../events.js';
import {
  actorInput,
  addEventInput,
  addTodoInput,
  DEFAULT_EVENT_MINUTES,
  type AddEventInput,
  listFilterInput,
  ticketsInput,
  toItem,
  type TicketsInput,
  updateTodoInput,
  type AddTodoInput,
  type Item,
  type ListFilter,
  type UpdateTodoInput,
} from './model.js';

const DEFAULT_LIMIT = 200;

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError(z.prettifyError(r.error));
  return r.data;
}

/**
 * All item mutations by users and MCP clients go through here.
 * Deliberately has no delete method: items are completed or archived, never removed.
 */
export class ItemService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly events: CoreEvents,
  ) {}

  get(id: string): Item {
    return toItem(this.getRow(id));
  }

  list(filter: ListFilter = {}): Item[] {
    const f = parse(listFilterInput, filter);
    const where: SQL[] = [];

    if (f.status !== 'all') {
      const statuses: ItemStatus[] = Array.isArray(f.status) ? f.status : [f.status ?? 'open'];
      where.push(inArray(items.status, statuses));
    }
    if (f.type) where.push(eq(items.type, f.type));
    if (f.source) where.push(eq(items.source, f.source));

    const effectiveDue = sql<number | null>`coalesce(${items.dueAt}, ${items.startsAt})`;
    if (f.dueBefore) where.push(lte(effectiveDue, f.dueBefore.getTime()));

    const rows = this.db
      .select()
      .from(items)
      .where(where.length ? and(...where) : undefined)
      .orderBy(sql`${effectiveDue} is null`, asc(effectiveDue), desc(items.createdAt))
      .limit(f.limit ?? DEFAULT_LIMIT)
      .all();
    return rows.map(toItem);
  }

  addTodo(input: AddTodoInput, actor: Actor): Item {
    const a = parse(actorInput, actor);
    const v = parse(addTodoInput, input);
    const now = this.clock.now();
    const row = this.db
      .insert(items)
      .values({
        id: ulid(now.getTime()),
        type: 'todo',
        source: 'manual',
        title: v.title,
        notes: v.notes ?? null,
        link: v.link ?? null,
        dueAt: v.dueAt ?? null,
        bsmUrl: v.bsmUrl ?? null,
        otmaUrl: v.otmaUrl ?? null,
        status: 'open',
        createdBy: a,
        updatedBy: a,
        statusChangedBy: a,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.events.emit('items-changed', { reason: 'created', actor: a, ids: [row.id] });
    return toItem(row);
  }

  /** A manual appointment. Calendar syncs never touch it (they only manage their own source). */
  addEvent(input: AddEventInput, actor: Actor): Item {
    const a = parse(actorInput, actor);
    const v = parse(addEventInput, input);
    const now = this.clock.now();
    const endsAt = v.endsAt ?? new Date(v.startsAt.getTime() + DEFAULT_EVENT_MINUTES * 60_000);
    const row = this.db
      .insert(items)
      .values({
        id: ulid(now.getTime()),
        type: 'event',
        source: 'manual',
        title: v.title,
        notes: v.notes ?? null,
        link: v.link ?? null,
        startsAt: v.startsAt,
        endsAt,
        status: 'open',
        createdBy: a,
        updatedBy: a,
        statusChangedBy: a,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.events.emit('items-changed', { reason: 'created', actor: a, ids: [row.id] });
    return toItem(row);
  }

  /**
   * Sets or clears (null) the BSM / OTMA ticket links of a todo or pull request. Works on
   * synced PRs too: the sync never writes these columns, so they survive every sync.
   */
  setTickets(id: string, input: TicketsInput, actor: Actor): Item {
    const a = parse(actorInput, actor);
    const v = parse(ticketsInput, input);
    const row = this.getRow(id);
    if (row.type !== 'todo' && row.type !== 'pr') {
      throw new ForbiddenOperationError(`tickets can only be set on todos and pull requests`);
    }
    const updated = this.db
      .update(items)
      .set({
        ...(v.bsmUrl !== undefined && { bsmUrl: v.bsmUrl }),
        ...(v.otmaUrl !== undefined && { otmaUrl: v.otmaUrl }),
        updatedBy: a,
        updatedAt: this.clock.now(),
      })
      .where(eq(items.id, id))
      .returning()
      .get();
    this.events.emit('items-changed', { reason: 'updated', actor: a, ids: [id] });
    return toItem(updated);
  }

  updateTodo(id: string, patch: UpdateTodoInput, actor: Actor): Item {
    const a = parse(actorInput, actor);
    const v = parse(updateTodoInput, patch);
    const current = this.getRow(id);
    this.requireTodo(current);
    const meta = { ...current.meta };
    for (const key of ['project', 'agentBranch'] as const) {
      if (v[key] === null) delete meta[key];
      else if (v[key] !== undefined) meta[key] = v[key];
    }

    const row = this.db
      .update(items)
      .set({
        ...(v.title !== undefined && { title: v.title }),
        ...(v.notes !== undefined && { notes: v.notes }),
        ...(v.link !== undefined && { link: v.link }),
        ...(v.dueAt !== undefined && { dueAt: v.dueAt }),
        ...((v.project !== undefined || v.agentBranch !== undefined) && { meta }),
        updatedBy: a,
        updatedAt: this.clock.now(),
      })
      .where(eq(items.id, id))
      .returning()
      .get();
    this.events.emit('items-changed', { reason: 'updated', actor: a, ids: [id] });
    return toItem(row);
  }

  completeTodo(id: string, actor: Actor): Item {
    const row = this.getRow(id);
    this.requireTodo(row);
    if (row.status === 'archived') {
      throw new ForbiddenOperationError(`item ${id} is archived; reopen it first`);
    }
    return this.setStatus(row, 'done', actor);
  }

  /** Works for every item type: hides a PR or event the user does not care about. */
  archiveItem(id: string, actor: Actor): Item {
    return this.setStatus(this.getRow(id), 'archived', actor);
  }

  reopenItem(id: string, actor: Actor): Item {
    return this.setStatus(this.getRow(id), 'open', actor);
  }

  private setStatus(row: ItemRow, status: ItemStatus, actor: Actor): Item {
    const a = parse(actorInput, actor);
    if (row.status === status) return toItem(row);
    const now = this.clock.now();
    const updated = this.db
      .update(items)
      .set({
        status,
        statusChangedBy: a,
        updatedBy: a,
        updatedAt: now,
        completedAt: status === 'done' ? now : null,
      })
      .where(eq(items.id, row.id))
      .returning()
      .get();
    this.events.emit('items-changed', { reason: 'status', actor: a, ids: [row.id] });
    return toItem(updated);
  }

  private getRow(id: string): ItemRow {
    const row = this.db.select().from(items).where(eq(items.id, id)).get();
    if (!row) throw new NotFoundError(`item ${id} not found`);
    return row;
  }

  private requireTodo(row: ItemRow): void {
    if (row.type !== 'todo') {
      throw new ForbiddenOperationError(
        `item ${row.id} is a ${row.type} from ${row.source}; only todos can be edited or completed (use archive instead)`,
      );
    }
  }
}
