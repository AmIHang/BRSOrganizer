import { describe, expect, it } from 'vitest';
import { makeCore, StaticSource } from '../../core/test/helpers.js';
import { bsmCustomer, mapProjects } from '../src/tickets/project.js';

const BSM = 'https://bsm.boomsoftware.com/indication/';
const map = (core: ReturnType<typeof makeCore>) => core.settings.get().workspace.bsmProjects;

describe('BSM customer → project mapping', () => {
  it('takes everything before the last lowercase letter of the ticket', () => {
    expect(bsmCustomer(`${BSM}STBBRSg0034`)).toBe('STBBRS');
    expect(bsmCustomer('BRS_PWg0127')).toBe('BRS_PW');
    expect(bsmCustomer(`${BSM}NorthrailBRSg0094/`)).toBe('NorthrailBRS');
    expect(bsmCustomer('12345')).toBeNull();
    expect(bsmCustomer(null)).toBeNull();
  });

  it('learns from existing items at start, newest first, filling gaps only', () => {
    const core = makeCore();
    core.settings.update({ workspace: { bsmProjects: { KEEP: 'Alt' } } });
    const old = core.items.addTodo({ title: 'a', bsmUrl: `${BSM}STBBRSg0001` }, 'user');
    core.items.updateTodo(old.id, { project: 'Erst' }, 'user');
    core.fakeClock.advance(1000);
    const recent = core.items.addTodo({ title: 'b', bsmUrl: `${BSM}STBBRSg0002` }, 'user');
    core.items.updateTodo(recent.id, { project: 'STB' }, 'user');
    const keep = core.items.addTodo({ title: 'c', bsmUrl: 'KEEPg1' }, 'user');
    core.items.updateTodo(keep.id, { project: 'Neu' }, 'user');

    mapProjects(core);
    expect(map(core)).toEqual({ KEEP: 'Alt', STBBRS: 'STB' });
  });

  it('learns when a todo with a BSM ticket gets a project, and applies it to the next ticket', () => {
    const core = makeCore();
    mapProjects(core);
    const first = core.items.addTodo({ title: 'a', bsmUrl: `${BSM}STBBRSg0034` }, 'user');
    expect(map(core)).toEqual({});
    core.items.updateTodo(first.id, { project: 'STB' }, 'user');
    expect(map(core)).toEqual({ STBBRS: 'STB' });

    // New todo of the same customer: takes the project right away.
    const next = core.items.addTodo({ title: 'b', bsmUrl: `${BSM}STBBRSg0035` }, 'claude');
    expect(core.items.get(next.id).meta?.project).toBe('STB');
    expect(core.items.get(next.id).updatedBy).toBe('claude');

    // Ticket set later (e.g. found through the OTMA ticket): applied as well.
    const later = core.items.addTodo({ title: 'c' }, 'user');
    core.items.setTickets(later.id, { bsmUrl: 'STBBRSg0036' }, 'user');
    expect(core.items.get(later.id).meta?.project).toBe('STB');

    // The user moves one to another project: the mapping follows the newest choice.
    core.items.updateTodo(later.id, { project: 'Steiermarkbahn' }, 'user');
    expect(map(core)).toEqual({ STBBRS: 'Steiermarkbahn' });
  });

  it('learns from synced PRs with a BSM ticket without overriding a choice', async () => {
    const core = makeCore();
    mapProjects(core);
    const pr = (project: string) =>
      new StaticSource('tfs', [
        { externalId: 'pr-1', type: 'pr', title: 'feat', link: null, meta: { project } },
      ]);
    await core.sync.run(pr('Rail-X'));
    const id = core.items.list({ type: 'pr' })[0]!.id;
    core.items.setTickets(id, { bsmUrl: `${BSM}RXBRSf0038` }, 'user');
    expect(map(core)).toEqual({ RXBRS: 'Rail-X' });

    core.settings.update({ workspace: { bsmProjects: { RXBRS: 'Gewählt' } } });
    await core.sync.run(pr('Anders'));
    expect(map(core)).toEqual({ RXBRS: 'Gewählt' });
  });
});
