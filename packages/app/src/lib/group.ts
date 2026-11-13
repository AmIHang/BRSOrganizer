import type { Item } from './types';

export type SectionKey = 'overdue' | 'now' | 'reviews' | 'today' | 'soon' | 'later' | 'undated';

export interface Section {
  key: SectionKey;
  title: string;
  items: Item[];
  /** Pull requests only: the same items, grouped by customer. */
  groups?: CustomerGroup[];
}

export interface CustomerGroup {
  customer: string;
  items: Item[];
}

/**
 * Customer of a PR: the Azure DevOps project (one project per customer, e.g. "STB"), or the
 * owner part of a GitHub "owner/repo".
 */
export function customerOf(item: Item): string {
  const project = item.meta?.project;
  if (typeof project === 'string' && project.trim()) return project.trim();
  const repo = item.meta?.repo;
  if (typeof repo === 'string' && repo.includes('/')) return repo.split('/')[0]!;
  if (typeof repo === 'string' && repo.trim()) return repo.trim();
  return 'Sonstige';
}

/**
 * Groups already sorted PRs by customer. A group is placed where its most urgent PR stands, so
 * customers with active review requests come before those with only drafts.
 */
export function groupByCustomer(sorted: Item[]): CustomerGroup[] {
  const groups = new Map<string, Item[]>();
  for (const item of sorted) {
    const customer = customerOf(item);
    const list = groups.get(customer) ?? [];
    list.push(item);
    groups.set(customer, list);
  }
  return [...groups].map(([customer, items]) => ({ customer, items }));
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
/** Appointments starting later than this are not shown. */
export const EVENT_HORIZON_MS = 48 * HOUR;

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
      // Over: synced events get closed by the next sync, manual ones simply drop out of view.
      if (!Number.isNaN(end) && end <= t) continue;
      // Further out than the horizon: not relevant yet, shown once it comes closer.
      if (!Number.isNaN(start) && start > t + EVENT_HORIZON_MS) continue;
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

  return ORDER.map((key): Section => {
    const sorted = [...buckets.get(key)!].sort(key === 'reviews' ? reviewFirst : byWhen);
    return {
      key,
      title: TITLES[key],
      items: sorted,
      ...(key === 'reviews' && { groups: groupByCustomer(sorted) }),
    };
  }).filter((s) => s.items.length > 0);
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
