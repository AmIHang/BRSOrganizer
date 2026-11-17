import { describe, expect, it } from 'vitest';
import { parseSseBlock } from '../src/lib/api';
import { groupItems, projectsOf, upcomingEvents } from '../src/lib/group';
import type { Item } from '../src/lib/types';

const NOW = new Date(2026, 10, 12, 10, 0, 0); // Thu 12 Nov 2026, 10:00 local

let seq = 0;
function item(partial: Partial<Item>): Item {
  seq++;
  return {
    id: `id${seq}`,
    type: 'todo',
    title: `item ${seq}`,
    notes: null,
    link: null,
    dueAt: null,
    startsAt: null,
    endsAt: null,
    status: 'open',
    source: 'manual',
    externalId: null,
    meta: null,
    createdBy: 'user',
    updatedBy: 'user',
    statusChangedBy: 'user',
    createdAt: new Date(2026, 10, 1, 0, 0, seq).toISOString(),
    updatedAt: new Date(2026, 10, 1).toISOString(),
    completedAt: null,
    lastSeenAt: null,
    bsmUrl: null,
    otmaUrl: null,
    ...partial,
  };
}

const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(2026, 10, 12 + dayOffset, h, m).toISOString();

describe('todos in projects', () => {
  it('files a todo with a project under that project next to its pull requests', () => {
    const pr = item({ type: 'pr', meta: { project: 'STB' } });
    const todo = item({ meta: { project: 'STB' }, dueAt: at(9) });
    const loose = item({});
    const sections = groupItems([pr, todo, loose], NOW);
    const reviews = sections.find((s) => s.key === 'reviews')!;
    expect(reviews.groups).toEqual([{ customer: 'STB', items: [todo, pr] }]);
    expect(sections.find((s) => s.key === 'undated')!.items).toEqual([loose]);
    expect(projectsOf([pr, todo, item({ type: 'pr', meta: { repo: 'acme/x' } })])).toEqual([
      'acme',
      'STB',
    ]);
  });
});

describe('groupItems', () => {
  it('sorts items into urgency sections', () => {
    const items = [
      item({ title: 'overdue', dueAt: at(9) }),
      item({ title: 'due in 30 min', dueAt: at(10, 30) }),
      item({ title: 'due tonight', dueAt: at(20) }),
      item({ title: 'due in 3 days', dueAt: at(12, 0, 3) }),
      item({ title: 'due next month', dueAt: at(12, 0, 30) }),
      item({ title: 'no date' }),
      item({ type: 'event', title: 'meeting running', startsAt: at(9, 30), endsAt: at(10, 30) }),
      item({ type: 'event', title: 'meeting at 10:45', startsAt: at(10, 45), endsAt: at(11) }),
      item({ type: 'event', title: 'meeting at 16:00', startsAt: at(16), endsAt: at(17) }),
      item({ type: 'pr', title: 'my PR', meta: { reasons: ['authored'] } }),
      item({ type: 'pr', title: 'review me', meta: { reasons: ['review-requested'] } }),
    ];

    const sections = groupItems(items, NOW);
    expect(sections.map((s) => [s.key, s.items.map((i) => i.title)])).toEqual([
      ['overdue', ['overdue']],
      ['now', ['meeting running', 'due in 30 min', 'meeting at 10:45']],
      ['reviews', ['review me', 'my PR']],
      ['today', ['meeting at 16:00', 'due tonight']],
      // Below the tasks, above the next days' dates.
      ['undated', ['no date']],
      ['soon', ['due in 3 days']],
      ['later', ['due next month']],
    ]);
  });

  it('puts draft PRs below active ones', () => {
    const items = [
      item({
        type: 'pr',
        title: 'draft review',
        meta: { reasons: ['review-requested'], draft: true },
      }),
      item({ type: 'pr', title: 'my draft', meta: { reasons: ['authored'], draft: true } }),
      item({ type: 'pr', title: 'my active', meta: { reasons: ['authored'], draft: false } }),
      item({ type: 'pr', title: 'active review', meta: { reasons: ['review-requested'] } }),
    ];
    const [reviews] = groupItems(items, NOW);
    expect(reviews!.items.map((i) => i.title)).toEqual([
      'active review',
      'my active',
      'draft review',
      'my draft',
    ]);
  });

  it('groups pull requests by customer, most urgent customer first', () => {
    const items = [
      item({ type: 'pr', title: 'stb draft', meta: { project: 'STB', repo: 'STB', draft: true } }),
      item({
        type: 'pr',
        title: 'brs active',
        meta: { project: 'BRSProduktion', repo: 'Community' },
      }),
      item({
        type: 'pr',
        title: 'stb review',
        meta: { project: 'STB', repo: 'STB', reasons: ['review-requested'] },
      }),
      item({ type: 'pr', title: 'gh', meta: { repo: 'acme/app' } }),
      item({ type: 'pr', title: 'unknown', meta: null }),
    ];
    const [reviews] = groupItems(items, NOW);
    // PR order: review request, then active ones newest first (unknown, gh, brs), then drafts.
    // Each customer group sits where its first PR stands.
    expect(reviews!.groups!.map((g) => [g.customer, g.items.map((i) => i.title)])).toEqual([
      ['STB', ['stb review', 'stb draft']],
      ['Sonstige', ['unknown']],
      ['acme', ['gh']],
      ['BRSProduktion', ['brs active']],
    ]);
    // Grouping only rearranges: all PRs are still there.
    expect(reviews!.groups!.flatMap((g) => g.items)).toHaveLength(5);
  });

  it('hides events starting more than 48 hours ahead', () => {
    const items = [
      item({ type: 'event', title: 'in 47h', startsAt: at(9, 0, 2), endsAt: at(10, 0, 2) }),
      item({ type: 'event', title: 'in 49h', startsAt: at(11, 0, 2), endsAt: at(12, 0, 2) }),
      item({ title: 'todo in 5 days', dueAt: at(9, 0, 5) }),
    ];
    expect(groupItems(items, NOW).flatMap((s) => s.items.map((i) => i.title))).toEqual([
      'in 47h',
      'todo in 5 days',
    ]);
  });

  it('hides events that are over', () => {
    const items = [
      item({ type: 'event', title: 'yesterday', startsAt: at(9, 0, -1), endsAt: at(10, 0, -1) }),
      item({ type: 'event', title: 'this morning', startsAt: at(8), endsAt: at(9) }),
      item({ type: 'event', title: 'later', startsAt: at(15), endsAt: at(16) }),
    ];
    expect(groupItems(items, NOW).flatMap((s) => s.items.map((i) => i.title))).toEqual(['later']);
  });

  it('omits empty sections', () => {
    expect(groupItems([item({ title: 'x' })], NOW).map((s) => s.key)).toEqual(['undated']);
  });
});

describe('upcomingEvents', () => {
  it('finds timed events starting within the window', () => {
    const soon = item({ type: 'event', startsAt: at(10, 8) });
    const later = item({ type: 'event', startsAt: at(10, 30) });
    const allDay = item({ type: 'event', startsAt: at(10, 5), meta: { allDay: true } });
    const started = item({ type: 'event', startsAt: at(9, 55) });
    expect(upcomingEvents([soon, later, allDay, started], NOW, 10 * 60_000)).toEqual([soon]);
  });
});

describe('parseSseBlock', () => {
  it('parses named events and ignores comments', () => {
    expect(parseSseBlock(': ping')).toBeNull();
    expect(
      parseSseBlock('event: items-changed\ndata: {"reason":"sync","actor":"sync","ids":["a"]}'),
    ).toEqual({ type: 'items-changed', data: { reason: 'sync', actor: 'sync', ids: ['a'] } });
  });
});
