import ICAL from 'ical.js';
import type { Clock } from '../clock.js';
import type { ExternalItem, SyncSource } from './engine.js';

export type FetchText = (url: string) => Promise<string>;

const FETCH_TIMEOUT_MS = 30_000;
const MAX_OCCURRENCES_SCANNED = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fetches a feed without ever putting the URL into an error message:
 * private ICS URLs (Google "secret address", Outlook published calendars) are credentials.
 */
export const defaultFetchText: FetchText = async (url) => {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'text/calendar, text/plain;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    throw new Error(`calendar feed request failed (${code})`);
  }
  if (!res.ok) throw new Error(`calendar feed request failed: HTTP ${res.status}`);
  return res.text();
};

export function normalizeFeedUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.replace(/^webcals?:\/\//i, 'https://');
}

export interface IcsSourceOptions {
  /** Read lazily so a changed URL in the Credential Manager is picked up without restart. */
  getUrl: () => string | null;
  lookAheadDays: number;
  clock: Clock;
  fetchText?: FetchText;
}

export class IcsCalendarSource implements SyncSource {
  readonly id = 'calendar' as const;

  constructor(private readonly options: IcsSourceOptions) {}

  async fetchSnapshot(): Promise<ExternalItem[]> {
    const url = this.options.getUrl();
    if (!url) throw new Error('no calendar feed URL configured');
    const text = await (this.options.fetchText ?? defaultFetchText)(normalizeFeedUrl(url));
    const from = this.options.clock.now();
    const to = new Date(from.getTime() + this.options.lookAheadDays * DAY_MS);
    return parseIcsEvents(text, { from, to });
  }
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

/**
 * Returns events (and expanded recurrences) that are not over yet at `from` and start before `to`.
 * Events that have ended drop out of the snapshot, so the sync engine marks them done.
 */
export function parseIcsEvents(text: string, window: TimeWindow): ExternalItem[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch (e) {
    throw new Error(`calendar feed is not valid iCalendar: ${(e as Error).message}`.slice(0, 300));
  }

  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(vtz);
  }

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(vevent);
    if (!ev.uid) continue;
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else masters.set(`${ex.uid}#${ex.recurrenceId.toString()}`, ex); // orphaned override
  }

  const out: ExternalItem[] = [];
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();

  for (const master of masters.values()) {
    if (!master.isRecurring()) {
      const start = master.startDate.toJSDate();
      const end = endOf(master.startDate, master.endDate);
      if (end.getTime() > fromMs && start.getTime() < toMs && !isCancelled(master.component)) {
        out.push(toExternal(master, master.uid, start, end, master.startDate.isDate));
      }
      continue;
    }

    const it = master.iterator();
    for (let i = 0; i < MAX_OCCURRENCES_SCANNED; i++) {
      const next = it.next();
      if (!next) break;
      const details = master.getOccurrenceDetails(next);
      const start = details.startDate.toJSDate();
      if (start.getTime() >= toMs) break;
      const end = endOf(details.startDate, details.endDate);
      if (end.getTime() <= fromMs) continue;
      const occ = details.item;
      if (isCancelled(occ.component)) continue;
      const externalId = `${master.uid}#${details.recurrenceId.toJSDate().toISOString()}`;
      out.push(toExternal(occ, externalId, start, end, details.startDate.isDate));
    }
  }

  return out.sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime());
}

function endOf(start: ICAL.Time, end: ICAL.Time | null | undefined): Date {
  if (end) return end.toJSDate();
  // No DTEND/DURATION: all-day events last one day, timed events are instantaneous.
  const s = start.toJSDate();
  return start.isDate ? new Date(s.getTime() + DAY_MS) : s;
}

function isCancelled(component: ICAL.Component): boolean {
  return String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function toExternal(
  ev: ICAL.Event,
  externalId: string,
  start: Date,
  end: Date,
  allDay: boolean,
): ExternalItem {
  const url = ev.component.getFirstPropertyValue('url');
  return {
    externalId,
    type: 'event',
    title: ev.summary || '(untitled event)',
    notes: ev.description || null,
    link: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null,
    startsAt: start,
    endsAt: end,
    meta: {
      location: ev.location || null,
      allDay,
      organizer: organizerOf(ev.component),
    },
  };
}

function organizerOf(component: ICAL.Component): string | null {
  const v = component.getFirstPropertyValue('organizer');
  return typeof v === 'string' ? v.replace(/^mailto:/i, '') : null;
}
