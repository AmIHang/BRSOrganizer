import type { Item } from './types';

export type SectionKey = 'overdue' | 'now' | 'reviews' | 'today' | 'soon' | 'later' | 'undated';

export interface Section {
  key: SectionKey;
  title: string;
  items: Item[];
}

const TITLES: Record<SectionKey, string> = {
  overdue: 'Überfällig',
  now: 'Jetzt',
  reviews: 'Pull Requests',
  today: 'Heute',
  soon: 'Nächste 7 Tage',
  later: 'Später',
  undated: 'Ohne Termin',
};
const ORDER: SectionKey[] = ['overdue', 'now', 'reviews', 'today', 'soon', 'later', 'undated'];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** When something needs attention: due date for todos, start for events. */
export function whenOf(item: Item): Date | null {
  const v = item.type === 'event' ? item.startsAt : item.dueAt;
  return v ? new Date(v) : null;
}

function endOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

const prReasons = (item: Item): string[] =>
  Array.isArray(item.meta?.reasons) ? (item.meta.reasons as string[]) : [];

/** Groups open items by urgency. Review requests rank above own/assigned PRs. */
export function groupItems(items: Item[], now: Date): Section[] {
  const t = now.getTime();
  const buckets = new Map<SectionKey, Item[]>(ORDER.map((k) => [k, []]));

  for (const item of items) {
    let key: SectionKey;
    if (item.type === 'pr') {
      key = 'reviews';
    } else if (item.type === 'event') {
      const start = item.startsAt ? Date.parse(item.startsAt) : NaN;
      const end = item.endsAt ? Date.parse(item.endsAt) : start;
      if (Number.isNaN(start)) key = 'undated';
      else if (start <= t + HOUR && end > t) key = 'now';
      else if (start <= endOfDay(now)) key = 'today';
      else if (start <= t + 7 * DAY) key = 'soon';
      else key = 'later';
    } else {
      const due = item.dueAt ? Date.parse(item.dueAt) : NaN;
      if (Number.isNaN(due)) key = 'undated';
      else if (due < t) key = 'overdue';
      else if (due <= t + HOUR) key = 'now';
      else if (due <= endOfDay(now)) key = 'today';
      else if (due <= t + 7 * DAY) key = 'soon';
      else key = 'later';
    }
    buckets.get(key)!.push(item);
  }

  const byWhen = (a: Item, b: Item) =>
    (whenOf(a)?.getTime() ?? Infinity) - (whenOf(b)?.getTime() ?? Infinity);
  // Active PRs before drafts; within each, review requests first, then newest first.
  const isDraft = (i: Item) => i.meta?.draft === true;
  const reviewFirst = (a: Item, b: Item) =>
    Number(isDraft(a)) - Number(isDraft(b)) ||
    Number(prReasons(b).includes('review-requested')) -
      Number(prReasons(a).includes('review-requested')) ||
    b.createdAt.localeCompare(a.createdAt);

  return ORDER.map((key) => ({
    key,
    title: TITLES[key],
    items: [...buckets.get(key)!].sort(key === 'reviews' ? reviewFirst : byWhen),
  })).filter((s) => s.items.length > 0);
}

/** Short German label like "heute 14:30", "Mo 9:00", "12.12." */
export function formatWhen(d: Date, now: Date, allDay = false): string {
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + DAY).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  const prefix = sameDay
    ? 'heute'
    : tomorrow
      ? 'morgen'
      : Math.abs(d.getTime() - now.getTime()) < 6 * DAY
        ? d.toLocaleDateString('de-AT', { weekday: 'short' })
        : d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' });
  return allDay ? prefix : `${prefix} ${time}`;
}

/** Events starting within `withinMs` that have not been announced yet. */
export function upcomingEvents(items: Item[], now: Date, withinMs: number): Item[] {
  const t = now.getTime();
  return items.filter((i) => {
    if (i.type !== 'event' || i.status !== 'open' || !i.startsAt || i.meta?.allDay) return false;
    const start = Date.parse(i.startsAt);
    return start > t && start <= t + withinMs;
  });
}
