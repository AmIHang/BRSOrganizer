import { describe, expect, it } from 'vitest';
import { parseSseBlock } from '../src/lib/api';
import { groupItems, upcomingEvents } from '../src/lib/group';
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
    ...partial,
  };
}

const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(2026, 10, 12 + dayOffset, h, m).toISOString();

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
      ['soon', ['due in 3 days']],
      ['later', ['due next month']],
      ['undated', ['no date']],
    ]);
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
