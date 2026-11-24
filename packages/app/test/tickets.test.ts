import { describe, expect, it } from 'vitest';
import { openPrsForTicket } from '../src/lib/tickets';
import type { Item } from '../src/lib/types';

const pr = (over: Partial<Item>): Item =>
  ({
    type: 'pr',
    status: 'open',
    title: 'x',
    bsmUrl: null,
    otmaUrl: null,
    meta: {},
    ...over,
  }) as Item;

describe('openPrsForTicket', () => {
  const linked = pr({ bsmUrl: 'https://bsm.boomsoftware.com/indication/FTBRSg0052' });
  const named = pr({ title: 'feat(FTBRSg0065): Reinigung' });
  const branch = pr({ meta: { sourceBranch: 'feature/BRS_PWg0127-x' } });
  const otma = pr({ otmaUrl: 'https://otma.boomsoftware.com/ap/177005' });
  const done = pr({ status: 'done', bsmUrl: 'https://bsm.boomsoftware.com/indication/FTBRSg0052' });
  const items = [linked, named, branch, otma, done];

  it('finds open PRs by linked ticket, title or branch', () => {
    expect(openPrsForTicket(items, 'ftbrsg0052', null)).toEqual([linked]);
    expect(
      openPrsForTicket(items, 'https://bsm.boomsoftware.com/indication/FTBRSg0065', ''),
    ).toEqual([named]);
    expect(openPrsForTicket(items, 'BRS_PWg0127', null)).toEqual([branch]);
    expect(openPrsForTicket(items, '', '#177005')).toEqual([otma]);
  });

  it('matches whole keys only and nothing without a ticket', () => {
    expect(openPrsForTicket(items, 'FTBRSg005', null)).toEqual([]);
    expect(openPrsForTicket(items, '', '')).toEqual([]);
  });
});
