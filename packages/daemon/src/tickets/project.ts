import type { Core, Item } from '@brsorganizer/core';

/**
 * Customer of a BSM ticket "<customer><lowercase letter><number>" (URL or bare key): everything
 * before the last lowercase letter, e.g. "STBBRS" of "STBBRSg0034".
 */
export function bsmCustomer(bsm: string | null | undefined): string | null {
  const key = (bsm ?? '').trim().replace(/\/+$/, '').split('/').pop() ?? '';
  return /^(.+)[a-z][^a-z]*$/.exec(key)?.[1] ?? null;
}

const projectOf = (item: Item) =>
  typeof item.meta?.project === 'string' ? item.meta.project : null;

/**
 * BSM customer → project, learned in the background: a todo or PR with a BSM ticket and a
 * project teaches the mapping (a user's or agent's choice replaces an old one, the sync only
 * fills gaps), and a todo without project that gets a BSM ticket takes the mapped project.
 * OTMA tickets count through the BSM ticket `linkTickets` finds for them.
 */
export function mapProjects(core: Core): void {
  const learn = (item: Item, replace: boolean) => {
    const customer = bsmCustomer(item.bsmUrl);
    const project = projectOf(item);
    if (!customer || !project) return;
    const map = core.settings.get().workspace.bsmProjects;
    if (map[customer] === project || (map[customer] && !replace)) return;
    core.settings.update({ workspace: { bsmProjects: { ...map, [customer]: project } } });
  };

  // Mappings from what is already there, newest first (fill only).
  // shortcut: the last 1000 todos and PRs each (the list limit); plenty for a learned map.
  const known = [
    ...core.items.list({ type: 'todo', status: 'all', limit: 1000 }),
    ...core.items.list({ type: 'pr', status: 'all', limit: 1000 }),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const item of known) learn(item, false);

  core.events.on('items-changed', ({ reason, actor, ids }) => {
    if (reason !== 'created' && reason !== 'updated' && reason !== 'sync') return;
    for (const id of ids) {
      const item = core.items.get(id);
      if (item.type !== 'todo' && item.type !== 'pr') continue;
      if (projectOf(item)) {
        learn(item, actor !== 'sync');
        continue;
      }
      const customer = bsmCustomer(item.bsmUrl);
      const mapped = customer ? core.settings.get().workspace.bsmProjects[customer] : undefined;
      if (item.type === 'todo' && item.status === 'open' && mapped) {
        core.items.updateTodo(id, { project: mapped }, actor);
      }
    }
  });
}
