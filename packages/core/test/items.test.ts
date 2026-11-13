import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenOperationError, NotFoundError, ValidationError } from '../src/errors.js';
import { ItemService } from '../src/items/service.js';
import { DAY, HOUR, makeCore, pr, StaticSource } from './helpers.js';

describe('ItemService', () => {
  let core: ReturnType<typeof makeCore>;
  beforeEach(() => {
    core = makeCore();
  });
  afterEach(() => core.close());

  describe('addTodo', () => {
    it('creates an open manual todo and records who created it', () => {
      const item = core.items.addTodo(
        { title: '  Release notes schreiben ', link: 'https://example.com/x', notes: 'n' },
        'claude',
      );
      expect(item).toMatchObject({
        type: 'todo',
        source: 'manual',
        status: 'open',
        title: 'Release notes schreiben',
        link: 'https://example.com/x',
        notes: 'n',
        createdBy: 'claude',
        updatedBy: 'claude',
        statusChangedBy: 'claude',
        externalId: null,
        createdAt: '2026-11-12T08:00:00.000Z',
      });
      expect(core.items.get(item.id)).toEqual(item);
    });

    it('requires a valid actor', () => {
      // @ts-expect-error -- runtime guard for callers outside TypeScript (MCP, REST)
      expect(() => core.items.addTodo({ title: 'x' }, undefined)).toThrow(ValidationError);
      // @ts-expect-error -- unknown actor
      expect(() => core.items.addTodo({ title: 'x' }, 'robot')).toThrow(ValidationError);
    });

    it.each([
      [{ title: '   ' }],
      [{ title: 'x', link: 'javascript:alert(1)' }],
      [{ title: 'x', link: 'file:///C:/secret' }],
      [{ title: 'x', dueAt: 'tomorrow' }],
      [{ title: 'x'.repeat(501) }],
    ])('rejects invalid input %j', (input) => {
      expect(() => core.items.addTodo(input, 'user')).toThrow(ValidationError);
    });

    it('treats a plain date as end of that local day', () => {
      const item = core.items.addTodo({ title: 'x', dueAt: '2026-11-20' }, 'user');
      const due = new Date(item.dueAt!);
      expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours()]).toEqual([
        2026, 10, 20, 23,
      ]);
    });

    it('accepts ISO date-times with offset', () => {
      const item = core.items.addTodo({ title: 'x', dueAt: '2026-11-20T10:00:00+01:00' }, 'user');
      expect(item.dueAt).toBe('2026-11-20T09:00:00.000Z');
    });

    it('emits items-changed', () => {
      const spy = vi.fn();
      core.events.on('items-changed', spy);
      const item = core.items.addTodo({ title: 'x' }, 'copilot');
      expect(spy).toHaveBeenCalledWith({ reason: 'created', actor: 'copilot', ids: [item.id] });
    });
  });

  describe('addEvent', () => {
    it('creates a manual event, 30 minutes long by default', () => {
      const e = core.items.addEvent(
        { title: 'Zahnarzt', startsAt: '2026-11-14T09:00:00+01:00' },
        'user',
      );
      expect(e).toMatchObject({
        type: 'event',
        source: 'manual',
        status: 'open',
        title: 'Zahnarzt',
        startsAt: '2026-11-14T08:00:00.000Z',
        endsAt: '2026-11-14T08:30:00.000Z',
        dueAt: null,
        createdBy: 'user',
      });
    });

    it('takes an explicit end and validates it', () => {
      const e = core.items.addEvent(
        { title: 'Workshop', startsAt: '2026-11-14T08:00:00Z', endsAt: '2026-11-14T12:00:00Z' },
        'claude',
      );
      expect(e.endsAt).toBe('2026-11-14T12:00:00.000Z');
      expect(() =>
        core.items.addEvent(
          { title: 'x', startsAt: '2026-11-14T08:00:00Z', endsAt: '2026-11-14T07:00:00Z' },
          'user',
        ),
      ).toThrow(ValidationError);
      // A plain date has no time: not a valid start for an appointment.
      expect(() => core.items.addEvent({ title: 'x', startsAt: '2026-11-14' }, 'user')).toThrow(
        ValidationError,
      );
    });

    it('is left alone by calendar syncs and cannot be completed like a todo', async () => {
      const e = core.items.addEvent({ title: 'Privat', startsAt: '2026-11-14T08:00:00Z' }, 'user');
      await core.sync.run(new StaticSource('calendar', []));
      expect(core.items.get(e.id).status).toBe('open');
      expect(() => core.items.completeTodo(e.id, 'user')).toThrow(ForbiddenOperationError);
      expect(core.items.archiveItem(e.id, 'user').status).toBe('archived');
    });
  });

  describe('updateTodo', () => {
    it('updates given fields, clears with null and tracks updated_by', () => {
      const t = core.items.addTodo({ title: 'a', notes: 'old', dueAt: '2026-11-20' }, 'user');
      core.fakeClock.advance(HOUR);
      const u = core.items.updateTodo(t.id, { title: 'b', notes: null }, 'claude');
      expect(u).toMatchObject({ title: 'b', notes: null, createdBy: 'user', updatedBy: 'claude' });
      expect(u.dueAt).toBe(t.dueAt);
      expect(u.updatedAt).toBe('2026-11-12T09:00:00.000Z');
    });

    it('rejects an empty patch', () => {
      const t = core.items.addTodo({ title: 'a' }, 'user');
      expect(() => core.items.updateTodo(t.id, {}, 'user')).toThrow(ValidationError);
    });

    it('refuses to edit synced items', async () => {
      await core.sync.run(new StaticSource('github', [pr('1')]));
      const [p] = core.items.list({ type: 'pr' });
      expect(() => core.items.updateTodo(p!.id, { title: 'x' }, 'claude')).toThrow(
        ForbiddenOperationError,
      );
      expect(() => core.items.completeTodo(p!.id, 'claude')).toThrow(ForbiddenOperationError);
    });

    it('throws NotFoundError for unknown ids', () => {
      expect(() => core.items.updateTodo('nope', { title: 'x' }, 'user')).toThrow(NotFoundError);
    });
  });

  describe('status changes', () => {
    it('completes, archives and reopens', () => {
      const t = core.items.addTodo({ title: 'a' }, 'user');
      const done = core.items.completeTodo(t.id, 'claude');
      expect(done).toMatchObject({ status: 'done', statusChangedBy: 'claude' });
      expect(done.completedAt).toBe('2026-11-12T08:00:00.000Z');

      const archived = core.items.archiveItem(t.id, 'user');
      expect(archived).toMatchObject({ status: 'archived', completedAt: null });

      expect(() => core.items.completeTodo(t.id, 'claude')).toThrow(ForbiddenOperationError);

      const reopened = core.items.reopenItem(t.id, 'user');
      expect(reopened.status).toBe('open');
    });

    it('is idempotent', () => {
      const t = core.items.addTodo({ title: 'a' }, 'user');
      const first = core.items.completeTodo(t.id, 'user');
      core.fakeClock.advance(HOUR);
      expect(core.items.completeTodo(t.id, 'claude')).toEqual(first);
    });

    it('can archive synced items', async () => {
      await core.sync.run(new StaticSource('github', [pr('1')]));
      const [p] = core.items.list({ type: 'pr' });
      expect(core.items.archiveItem(p!.id, 'user').status).toBe('archived');
    });
  });

  it('has no way to hard-delete items', () => {
    const proto = Object.getOwnPropertyNames(ItemService.prototype);
    expect(proto.filter((n) => /delete|remove|purge|destroy/i.test(n))).toEqual([]);
  });

  describe('list', () => {
    it('defaults to open items, sorted by due/start date with undated items last', async () => {
      const later = core.items.addTodo({ title: 'later', dueAt: '2026-11-30T10:00:00Z' }, 'user');
      const undated = core.items.addTodo({ title: 'undated' }, 'user');
      const soon = core.items.addTodo({ title: 'soon', dueAt: '2026-11-13T10:00:00Z' }, 'user');
      const done = core.items.addTodo({ title: 'done' }, 'user');
      core.items.completeTodo(done.id, 'user');
      await core.sync.run(
        new StaticSource('calendar', [
          {
            externalId: 'ev1',
            type: 'event',
            title: 'Standup',
            startsAt: new Date('2026-11-12T09:00:00Z'),
            endsAt: new Date('2026-11-12T09:15:00Z'),
          },
        ]),
      );

      expect(core.items.list().map((i) => i.title)).toEqual([
        'Standup',
        soon.title,
        later.title,
        undated.title,
      ]);
    });

    it('filters by type, status, source and dueBefore', () => {
      const a = core.items.addTodo({ title: 'a', dueAt: '2026-11-13T00:00:00Z' }, 'user');
      core.items.addTodo({ title: 'b', dueAt: '2026-12-13T00:00:00Z' }, 'user');
      const c = core.items.addTodo({ title: 'c' }, 'user');
      core.items.archiveItem(c.id, 'user');

      expect(core.items.list({ dueBefore: new Date(Date.parse('2026-11-12') + 7 * DAY) })).toEqual([
        core.items.get(a.id),
      ]);
      expect(core.items.list({ status: 'archived' }).map((i) => i.id)).toEqual([c.id]);
      expect(core.items.list({ status: 'all' })).toHaveLength(3);
      expect(core.items.list({ status: ['open', 'archived'] })).toHaveLength(3);
      expect(core.items.list({ type: 'pr' })).toEqual([]);
      expect(core.items.list({ source: 'manual' })).toHaveLength(2);
      expect(core.items.list({ limit: 1 })).toHaveLength(1);
    });
  });
});
