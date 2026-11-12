import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUR, makeCore, pr, StaticSource } from './helpers.js';

describe('SyncEngine', () => {
  let core: ReturnType<typeof makeCore>;
  let github: StaticSource;

  beforeEach(() => {
    core = makeCore();
    github = new StaticSource('github', [pr('A'), pr('B')]);
  });
  afterEach(() => core.close());

  const prs = (status: 'open' | 'done' | 'archived' | 'all' = 'all') =>
    core.items.list({ type: 'pr', status });
  const byExt = (id: string) => prs().find((i) => i.externalId === id)!;

  it('inserts new items as open, created by sync', async () => {
    const r = await core.sync.run(github);
    expect(r).toMatchObject({ ok: true, added: 2, updated: 0, closed: 0, reopened: 0 });
    expect(r.addedIds).toHaveLength(2);
    expect(
      prs('open')
        .map((i) => i.externalId)
        .sort(),
    ).toEqual(['A', 'B']);
    expect(byExt('A')).toMatchObject({
      source: 'github',
      createdBy: 'sync',
      statusChangedBy: 'sync',
      lastSeenAt: '2026-11-12T08:00:00.000Z',
    });
  });

  it('is idempotent: an identical snapshot changes nothing', async () => {
    await core.sync.run(github);
    const before = prs();
    core.fakeClock.advance(HOUR);

    const r = await core.sync.run(github);

    expect(r).toMatchObject({
      ok: true,
      added: 0,
      updated: 0,
      closed: 0,
      reopened: 0,
      unchanged: 2,
    });
    const after = prs();
    expect(after.map((i) => i.id)).toEqual(before.map((i) => i.id));
    expect(after.map((i) => i.updatedAt)).toEqual(before.map((i) => i.updatedAt));
    // Only the "seen" marker moves.
    expect(after.every((i) => i.lastSeenAt === '2026-11-12T09:00:00.000Z')).toBe(true);
  });

  it('treats meta with a different key order as unchanged', async () => {
    github.snapshot = [pr('A', { meta: { repo: 'r', number: 1 } })];
    await core.sync.run(github);
    github.snapshot = [pr('A', { meta: { number: 1, repo: 'r' } })];
    expect((await core.sync.run(github)).updated).toBe(0);
  });

  it('deduplicates repeated external ids within one snapshot (last wins)', async () => {
    github.snapshot = [pr('A', { title: 'first' }), pr('A', { title: 'second' })];
    const r = await core.sync.run(github);
    expect(r.added).toBe(1);
    expect(prs()).toHaveLength(1);
    expect(byExt('A').title).toBe('second');
  });

  it('keys by (source, external_id): the same id in two sources is two items', async () => {
    await core.sync.run(new StaticSource('github', [pr('X')]));
    await core.sync.run(
      new StaticSource('calendar', [{ externalId: 'X', type: 'event', title: 'Meeting' }]),
    );
    expect(core.items.list({ status: 'all' })).toHaveLength(2);
  });

  it('updates changed fields and keeps the id', async () => {
    await core.sync.run(github);
    const id = byExt('A').id;
    core.fakeClock.advance(HOUR);
    github.snapshot = [pr('A', { title: 'renamed', meta: { reasons: ['authored'] } }), pr('B')];

    const r = await core.sync.run(github);

    expect(r).toMatchObject({ updated: 1, unchanged: 1 });
    expect(byExt('A')).toMatchObject({
      id,
      title: 'renamed',
      meta: { reasons: ['authored'] },
      updatedBy: 'sync',
      updatedAt: '2026-11-12T09:00:00.000Z',
      createdAt: '2026-11-12T08:00:00.000Z',
    });
  });

  it('closes open items that disappeared from the snapshot', async () => {
    await core.sync.run(github);
    github.snapshot = [pr('A')];

    const r = await core.sync.run(github);

    expect(r).toMatchObject({ closed: 1 });
    expect(byExt('B')).toMatchObject({ status: 'done', statusChangedBy: 'sync' });
    expect(byExt('B').completedAt).not.toBeNull();
  });

  it('reopens items the sync itself closed when they come back', async () => {
    await core.sync.run(github);
    github.snapshot = [pr('A')];
    await core.sync.run(github);
    github.snapshot = [pr('A'), pr('B')];

    const r = await core.sync.run(github);

    expect(r).toMatchObject({ reopened: 1, added: 0 });
    expect(byExt('B')).toMatchObject({ status: 'open', completedAt: null });
  });

  it('never reopens or closes what the user archived', async () => {
    await core.sync.run(github);
    core.items.archiveItem(byExt('A').id, 'user');

    // Still present → stays archived.
    await core.sync.run(github);
    expect(byExt('A').status).toBe('archived');

    // Gone → not touched (it is not open).
    github.snapshot = [pr('B')];
    expect((await core.sync.run(github)).closed).toBe(0);
    expect(byExt('A')).toMatchObject({ status: 'archived', statusChangedBy: 'user' });

    // Back again → still archived.
    github.snapshot = [pr('A'), pr('B')];
    expect((await core.sync.run(github)).reopened).toBe(0);
    expect(byExt('A').status).toBe('archived');
  });

  it('closes nothing when the fetch fails and records the error', async () => {
    await core.sync.run(github);
    github.failWith = new Error('HTTP 502');

    const r = await core.sync.run(github);

    expect(r).toMatchObject({ ok: false, error: 'HTTP 502', closed: 0 });
    expect(prs('open')).toHaveLength(2);
    const [last] = core.sync.lastRuns(1);
    expect(last).toMatchObject({ source: 'github', ok: false, error: 'HTTP 502' });
  });

  it('records successful runs', async () => {
    await core.sync.run(github);
    const [last] = core.sync.lastRuns(1);
    expect(last).toMatchObject({ source: 'github', ok: true, added: 2, error: null });
    expect(last!.finishedAt).toBeInstanceOf(Date);
  });

  it('shares one run between concurrent calls for the same source', async () => {
    const [a, b] = await Promise.all([core.sync.run(github), core.sync.run(github)]);
    expect(github.calls).toBe(1);
    expect(a).toBe(b);
    expect(prs()).toHaveLength(2);
  });

  it('does not touch manual todos or other sources', async () => {
    const todo = core.items.addTodo({ title: 'mine' }, 'user');
    const cal = new StaticSource('calendar', [{ externalId: 'e', type: 'event', title: 'x' }]);
    await core.sync.run(cal);
    await core.sync.run(github);
    github.snapshot = [];
    await core.sync.run(github);

    expect(core.items.get(todo.id).status).toBe('open');
    expect(core.items.list({ type: 'event' })).toHaveLength(1);
  });

  it('truncates overlong titles and replaces empty ones', async () => {
    github.snapshot = [pr('A', { title: 'x'.repeat(800) }), pr('B', { title: '   ' })];
    await core.sync.run(github);
    expect(byExt('A').title).toHaveLength(500);
    expect(byExt('B').title).toBe('(untitled)');
  });

  it('emits events for added and changed items', async () => {
    const added = vi.fn();
    const changed = vi.fn();
    const finished = vi.fn();
    core.events.on('items-added-by-sync', added);
    core.events.on('items-changed', changed);
    core.events.on('sync-finished', finished);

    const r = await core.sync.run(github);
    expect(added).toHaveBeenCalledWith({ source: 'github', ids: r.addedIds });
    expect(finished).toHaveBeenCalledWith(r);

    changed.mockClear();
    await core.sync.run(github);
    expect(changed).not.toHaveBeenCalled();
  });

  describe('syncAll', () => {
    it('reports unconfigured sources and runs nothing', async () => {
      const r = await core.syncAll();
      expect(r).toEqual({
        results: [],
        status: { github: 'missing-token', calendar: 'missing-url', mail: 'disabled' },
      });
    });

    it('respects disabled sources', () => {
      core.settings.update({ github: { enabled: false } });
      expect(core.sourceStatus().github).toBe('disabled');
    });
  });
});
