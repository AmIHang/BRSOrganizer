import type { Clock } from '../clock.js';
import type { ExternalItem, SyncSource } from './engine.js';

/** One (expanded) appointment as read from the Outlook object model. */
export interface OutlookAppointment {
  /** GlobalAppointmentID: stable across Outlook clients; the same for all occurrences. */
  id: string;
  entryId: string;
  subject: string;
  /** ISO, UTC. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  organizer: string;
  /** OlBusyStatus: 0 free, 1 tentative, 2 busy, 3 out of office, 4 working elsewhere. */
  busyStatus: number;
  /** OlMeetingStatus: 5 canceled, 7 received and canceled. */
  meetingStatus: number;
  /** OlResponseStatus: 4 declined. */
  responseStatus: number;
  isRecurring: boolean;
  /** Teams join link found in the body, or empty. */
  joinUrl: string;
}

export type CalendarReader = (window: { from: Date; to: Date }) => Promise<OutlookAppointment[]>;

const CANCELED = new Set([5, 7]);
const DECLINED = 4;
const BUSY_LABELS: Record<number, string> = {
  0: 'free',
  1: 'tentative',
  2: 'busy',
  3: 'out-of-office',
  4: 'working-elsewhere',
};

/**
 * Maps appointments to calendar items. Skips canceled meetings and declined invitations, and
 * everything already over at `from`. Occurrences of a series get the start in their id, so a
 * moved occurrence becomes a new item and the old slot is closed by the sync.
 */
export function appointmentsToItems(
  appointments: OutlookAppointment[],
  window: { from: Date; to: Date },
): ExternalItem[] {
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  const out: ExternalItem[] = [];

  for (const a of appointments) {
    if (CANCELED.has(a.meetingStatus) || a.responseStatus === DECLINED) continue;
    const start = new Date(a.start);
    const end = new Date(a.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end.getTime() <= fromMs || start.getTime() >= toMs) continue;

    const base = a.id || a.entryId;
    if (!base) continue;
    const externalId = a.isRecurring ? `outlook:${base}#${start.toISOString()}` : `outlook:${base}`;

    out.push({
      externalId,
      type: 'event',
      title: a.subject.trim() || '(ohne Titel)',
      notes: null,
      link: /^https:\/\//.test(a.joinUrl) ? a.joinUrl : null,
      startsAt: start,
      endsAt: end,
      meta: {
        location: a.location.trim() || null,
        allDay: a.allDay,
        organizer: a.organizer.trim() || null,
        availability: BUSY_LABELS[a.busyStatus] ?? null,
        online: a.joinUrl.length > 0,
        provider: 'outlook',
      },
    });
  }

  // Two entries with the same id (e.g. a series exception listed twice): keep the first.
  const seen = new Set<string>();
  return out
    .filter((i) => !seen.has(i.externalId) && seen.add(i.externalId))
    .sort((a, b) => a.startsAt!.getTime() - b.startsAt!.getTime());
}

export interface OutlookCalendarSourceOptions {
  reader: CalendarReader;
  lookAheadDays: number;
  clock: Clock;
}

/** Calendar from the classic Outlook client (same source id as the ICS feed). */
export class OutlookCalendarSource implements SyncSource {
  readonly id = 'calendar' as const;

  constructor(private readonly options: OutlookCalendarSourceOptions) {}

  async fetchSnapshot(): Promise<ExternalItem[]> {
    const from = this.options.clock.now();
    const to = new Date(from.getTime() + this.options.lookAheadDays * 86_400_000);
    return appointmentsToItems(await this.options.reader({ from, to }), { from, to });
  }
}
