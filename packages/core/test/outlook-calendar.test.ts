import { describe, expect, it } from 'vitest';
import { appointmentsToItems, type OutlookAppointment } from '../src/sync/outlook-calendar.js';
import { DAY, HOUR, makeCore } from './helpers.js';

const NOW = new Date('2026-11-13T07:00:00.000Z');
const WINDOW = { from: NOW, to: new Date(NOW.getTime() + 14 * DAY) };

function appt(partial: Partial<OutlookAppointment>): OutlookAppointment {
  return {
    id: 'GID-1',
    entryId: 'EID-1',
    subject: 'Standup',
    start: '2026-11-13T07:45:00.000Z',
    end: '2026-11-13T08:00:00.000Z',
    allDay: false,
    location: 'Teams',
    organizer: 'Kollege Karl',
    busyStatus: 2,
    meetingStatus: 3,
    responseStatus: 3,
    isRecurring: false,
    joinUrl: '',
    ...partial,
  };
}

describe('appointmentsToItems', () => {
  it('maps an appointment to an event item', () => {
    const [item] = appointmentsToItems(
      [appt({ joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' })],
      WINDOW,
    );
    expect(item).toEqual({
      externalId: 'outlook:GID-1',
      type: 'event',
      title: 'Standup',
      notes: null,
      link: 'https://teams.microsoft.com/l/meetup-join/abc',
      startsAt: new Date('2026-11-13T07:45:00.000Z'),
      endsAt: new Date('2026-11-13T08:00:00.000Z'),
      meta: {
        location: 'Teams',
        allDay: false,
        organizer: 'Kollege Karl',
        availability: 'busy',
        online: true,
        provider: 'outlook',
      },
    });
  });

  it('gives each occurrence of a series its own id', () => {
    const items = appointmentsToItems(
      [
        appt({ isRecurring: true }),
        appt({
          isRecurring: true,
          start: '2026-11-16T07:45:00.000Z',
          end: '2026-11-16T08:00:00.000Z',
        }),
      ],
      WINDOW,
    );
    expect(items.map((i) => i.externalId)).toEqual([
      'outlook:GID-1#2026-11-13T07:45:00.000Z',
      'outlook:GID-1#2026-11-16T07:45:00.000Z',
    ]);
  });

  it('skips canceled meetings, declined invitations and what is already over', () => {
    const items = appointmentsToItems(
      [
        appt({ id: 'canceled', meetingStatus: 5 }),
        appt({ id: 'canceled-received', meetingStatus: 7 }),
        appt({ id: 'declined', responseStatus: 4 }),
        appt({ id: 'over', start: '2026-11-13T05:00:00.000Z', end: '2026-11-13T06:00:00.000Z' }),
        appt({
          id: 'too-late',
          start: '2026-12-01T07:00:00.000Z',
          end: '2026-12-01T08:00:00.000Z',
        }),
        appt({ id: 'tentative', busyStatus: 1 }),
      ],
      WINDOW,
    );
    expect(items.map((i) => i.externalId)).toEqual(['outlook:tentative']);
    expect(items[0]!.meta).toMatchObject({ availability: 'tentative' });
  });

  it('falls back to the entry id and deduplicates', () => {
    const items = appointmentsToItems([appt({ id: '' }), appt({ id: '' })], WINDOW);
    expect(items.map((i) => i.externalId)).toEqual(['outlook:EID-1']);
  });

  it('ignores non-https join links and fills empty subjects', () => {
    const [item] = appointmentsToItems([appt({ subject: '  ', joinUrl: 'javascript:x' })], WINDOW);
    expect(item).toMatchObject({ title: '(ohne Titel)', link: null });
  });
});

describe('Outlook calendar via sync', () => {
  it('syncs idempotently, picks up moves and closes past events', async () => {
    let appointments = [
      appt({}),
      appt({
        id: 'GID-2',
        subject: 'Review',
        start: '2026-11-13T12:00:00.000Z',
        end: '2026-11-13T13:00:00.000Z',
      }),
    ];
    const windows: Array<{ from: Date; to: Date }> = [];
    const core = makeCore({
      calendarReader: async (w) => {
        windows.push(w);
        return structuredClone(appointments);
      },
    });
    core.fakeClock.set(NOW);
    core.settings.update({
      github: { enabled: false },
      calendar: { provider: 'outlook', lookAheadDays: 7 },
    });
    try {
      expect(core.sourceStatus().calendar).toBe('ready');
      expect((await core.syncAll()).results).toMatchObject([
        { source: 'calendar', ok: true, added: 2 },
      ]);
      expect(windows[0]!.to.getTime() - windows[0]!.from.getTime()).toBe(7 * DAY);
      expect((await core.syncAll()).results).toMatchObject([{ added: 0, updated: 0, closed: 0 }]);

      // Meeting moved by an hour: same item, new time.
      appointments = [
        appointments[0]!,
        { ...appointments[1]!, start: '2026-11-13T13:00:00.000Z', end: '2026-11-13T14:00:00.000Z' },
      ];
      expect((await core.syncAll()).results).toMatchObject([{ updated: 1 }]);

      // Standup is over.
      core.fakeClock.advance(2 * HOUR);
      appointments = [appointments[1]!];
      expect((await core.syncAll()).results).toMatchObject([{ closed: 1 }]);
      expect(core.items.list({ type: 'event' }).map((i) => i.title)).toEqual(['Review']);
    } finally {
      core.close();
    }
  });

  it('does not need an ICS URL', async () => {
    const core = makeCore({ calendarReader: async () => [] });
    core.settings.update({ calendar: { provider: 'outlook' } });
    try {
      expect(core.sourceStatus().calendar).toBe('ready');
      core.settings.update({ calendar: { provider: 'ics' } });
      expect(core.sourceStatus().calendar).toBe('missing-url');
    } finally {
      core.close();
    }
  });
});
