import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OtmaTicket } from '../src/lib/types';

const ticket = (key: string): OtmaTicket => ({
  key,
  url: `https://otma.boomsoftware.com/ap/${key}`,
  title: `#T${key}`,
  bsm: '',
  status: 'Neu',
  responsible: '',
  project: '',
  changedAt: null,
});

let answer: OtmaTicket[] = [];
const calls: Array<[string, unknown]> = [];
vi.mock('../src/lib/api', () => ({
  api: {
    otmaTickets: () => Promise.resolve(answer),
    addTodo: (input: object) => {
      calls.push(['addTodo', input]);
      return Promise.resolve({ id: 'todo-1', ...input });
    },
    updateTodo: (id: string, patch: object) => {
      calls.push(['updateTodo', { id, ...patch }]);
      return Promise.resolve({ id, meta: patch });
    },
    updateSettings: (patch: object) => {
      calls.push(['updateSettings', patch]);
      return Promise.resolve(patch);
    },
  },
}));

describe('OTMA ticket as todo', () => {
  beforeEach(() => void (calls.length = 0));

  it('creates the todo with both tickets in the project and remembers the OTMA project', async () => {
    const { otmaToTodo } = await import('../src/lib/otma.svelte');
    const t = { ...ticket('178333'), bsm: 'STBBRSg0034', project: 'STB BRS [STBBRS]' };
    await otmaToTodo(t, 'Steiermarkbahn', { Other: 'X' });
    expect(calls).toEqual([
      [
        'addTodo',
        {
          title: '#T178333',
          otmaUrl: 'https://otma.boomsoftware.com/ap/178333',
          bsmUrl: 'STBBRSg0034',
        },
      ],
      ['updateTodo', { id: 'todo-1', project: 'Steiermarkbahn' }],
      [
        'updateSettings',
        { workspace: { otmaProjects: { Other: 'X', 'STB BRS [STBBRS]': 'Steiermarkbahn' } } },
      ],
    ]);
  });

  it('keeps the mapping when it already fits, and needs no project', async () => {
    const { otmaToTodo } = await import('../src/lib/otma.svelte');
    const t = { ...ticket('1'), project: 'P' };
    await otmaToTodo(t, 'Kunde', { P: 'Kunde' });
    expect(calls.map(([name]) => name)).toEqual(['addTodo', 'updateTodo']);
    calls.length = 0;
    await otmaToTodo(t, '', { P: 'Kunde' });
    expect(calls).toEqual([
      ['addTodo', { title: '#T1', otmaUrl: 'https://otma.boomsoftware.com/ap/1', bsmUrl: null }],
    ]);
  });
});

describe('OTMA new tickets', () => {
  beforeEach(() => {
    vi.resetModules();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it('counts tickets not yet seen in the tab; opening the tab highlights and clears them', async () => {
    const { otma, loadOtma, setOtmaVisible } = await import('../src/lib/otma.svelte');

    // First list ever: the baseline, nothing is new.
    answer = [ticket('1'), ticket('2')];
    await loadOtma();
    expect(otma.unseen).toEqual([]);

    // Ticket 2 is gone, 3 and 4 are new.
    answer = [ticket('1'), ticket('3'), ticket('4')];
    await loadOtma();
    expect(otma.tickets?.map((t) => t.key)).toEqual(['1', '3', '4']);
    expect(otma.unseen).toEqual(['3', '4']);

    setOtmaVisible(true);
    expect(otma.unseen).toEqual([]);
    expect(otma.highlighted).toEqual(['3', '4']);

    // New while the tab is open: highlighted at once, no bubble.
    answer = [ticket('1'), ticket('3'), ticket('4'), ticket('5')];
    await loadOtma();
    expect(otma.unseen).toEqual([]);
    expect(otma.highlighted).toEqual(['3', '4', '5']);

    setOtmaVisible(false);
    expect(otma.highlighted).toEqual([]);
    await loadOtma();
    expect(otma.unseen).toEqual([]);
  });

  it('keeps a ticket ignored until its change date changes; survives a restart', async () => {
    const mod = await import('../src/lib/otma.svelte');
    const t1 = { ...ticket('1'), changedAt: '2026-11-01T10:00:00.000Z' };
    answer = [t1, ticket('2')];
    await mod.loadOtma();
    mod.ignoreOtma(t1);
    mod.ignoreOtma(ticket('2'));
    await mod.loadOtma();
    expect(Object.keys(mod.otma.ignored)).toEqual(['1', '2']);

    // Fresh module (app restart): read back from storage. Ticket 1 changed, 2 is unchanged.
    vi.resetModules();
    const again = await import('../src/lib/otma.svelte');
    expect(Object.keys(again.otma.ignored)).toEqual(['1', '2']);
    answer = [{ ...t1, changedAt: '2026-11-18T09:00:00.000Z' }, ticket('2')];
    await again.loadOtma();
    expect(Object.keys(again.otma.ignored)).toEqual(['2']);

    again.unignoreOtma('2');
    expect(again.otma.ignored).toEqual({});

    again.ignoreAllOtma();
    expect(Object.keys(again.otma.ignored)).toEqual(['1', '2']);
    again.unignoreAllOtma();
    expect(again.otma.ignored).toEqual({});
  });

  it('remembers whether the tab is shown', async () => {
    const mod = await import('../src/lib/otma.svelte');
    expect(mod.otma.enabled).toBe(true);
    mod.setOtmaEnabled(false);
    vi.resetModules();
    expect((await import('../src/lib/otma.svelte')).otma.enabled).toBe(false);
  });
});
