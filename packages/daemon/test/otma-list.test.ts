import { afterEach, describe, expect, it } from 'vitest';
import { BsmLoginRequiredError, type BsmHttp, type BsmSession } from '../src/tickets/bsm.js';
import { OTMA_MY_TICKETS_REQUEST, parseOtmaTicketList } from '../src/tickets/otma.js';
import { auth, raw, startHarness, type Harness } from './harness.js';

/** Shape of the real "ShowMyOPs" answer, trimmed to what the parser reads. */
const answer = {
  ui: {
    style: { title: 'Arbeitspakete' },
    form: [
      {
        type: 'section',
        items: [
          {
            feat: 'Items',
            columns: [
              { name: 'SupportIDLink' },
              { name: 'Name' },
              { name: 'Order', hidden: true },
              { name: 'cfResponsiblePersonDisplayText' },
              { name: 'Status' },
              { name: 'Project' },
              { name: 'ChangeDate', type: 'Date' },
            ],
            data: [
              [
                { op: '2B89D@1000A5', cs: 1 },
                { op: '2B89D@1000A5', v: 1 },
                2,
                3,
                4,
                { op: 'x', v: 5 },
                1,
              ],
              // no BSM link, no date
              [{ op: '2BA3E@1000A5', cs: 0 }, { op: '2BA3E@1000A5', v: 0 }, 6, 3, 7, 0],
              [{ op: 'kaputt' }, 0, 2],
            ],
            strings: [
              '',
              'STBBRSg0034',
              '#STBBRSg0034: Titel',
              'GRA',
              'Zugewiesen',
              'STB BRS',
              'RO Gantt',
              'Neu',
            ],
            dates: [1793708423488],
          },
        ],
      },
    ],
  },
};

describe('OTMA ticket list', () => {
  it('asks only for the own work packages', () => {
    expect(OTMA_MY_TICKETS_REQUEST).toMatchObject({
      WorkflowType: 'View',
      WorkflowName: 'ShowMyOPs',
    });
    const list = OTMA_MY_TICKETS_REQUEST.Model.modified[1] as { FilterJson: string };
    const filter = JSON.parse(list.FilterJson) as {
      modified: Array<{ cfFilterOnlyMyOPs: boolean }>;
    };
    expect(filter.modified[0]!.cfFilterOnlyMyOPs).toBe(true);
  });

  it('reads visible columns, links and dates; the ticket number is the hex object id', () => {
    expect(parseOtmaTicketList(answer)).toEqual([
      {
        key: '178333',
        url: 'https://otma.boomsoftware.com/ap/178333',
        title: '#STBBRSg0034: Titel',
        bsm: 'STBBRSg0034',
        status: 'Zugewiesen',
        responsible: 'GRA',
        project: 'STB BRS',
        changedAt: '2026-11-03T12:20:23.488Z',
      },
      {
        key: '178750',
        url: 'https://otma.boomsoftware.com/ap/178750',
        title: 'RO Gantt',
        bsm: '',
        status: 'Neu',
        responsible: 'GRA',
        project: '',
        changedAt: null,
      },
    ]);
    expect(() => parseOtmaTicketList({ ui: { form: [] } })).toThrow(/keine Ticketliste/);
  });
});

describe('GET /api/otma/tickets', () => {
  let h: Harness;
  afterEach(() => h.close());

  const session =
    (http: Partial<BsmHttp>): BsmSession =>
    (fn) =>
      fn(http as BsmHttp);

  it('returns the list, a login problem as a readable 502, 404 without OTMA', async () => {
    const sent: unknown[] = [];
    h = await startHarness({
      otma: session({
        runWorkflow: (body) => {
          sent.push(body);
          return Promise.resolve(answer);
        },
      }),
    });
    const ok = await raw(h.port, { path: '/api/otma/tickets', headers: auth });
    expect(ok.status).toBe(200);
    expect(ok.json<{ tickets: unknown[] }>().tickets).toHaveLength(2);
    expect(sent).toEqual([OTMA_MY_TICKETS_REQUEST]);
    await h.close();

    h = await startHarness({
      otma: session({ runWorkflow: () => Promise.reject(new BsmLoginRequiredError('OTMA')) }),
    });
    const failed = await raw(h.port, { path: '/api/otma/tickets', headers: auth });
    expect(failed.status).toBe(502);
    expect(failed.json()).toEqual({ error: 'upstream', message: 'OTMA: nicht angemeldet' });
    await h.close();

    h = await startHarness();
    expect((await raw(h.port, { path: '/api/otma/tickets', headers: auth })).status).toBe(404);
  });
});
