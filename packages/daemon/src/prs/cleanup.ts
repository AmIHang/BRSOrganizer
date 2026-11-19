import type { Core } from '@brsorganizer/core';
import type { PrWorkspace } from './service.js';

/**
 * When an item leaves the list (a PR completed or abandoned, a todo done, anything archived),
 * its local leftovers go too: PR checkout with IIS app pool, agent worktree. Each item is handled
 * once per daemon run; what holds work stays (see PrWorkspace.cleanUpLeftItem).
 */
export function cleanUpLeftItems(
  core: Core,
  workspace: PrWorkspace,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
): void {
  const handled = new Set<string>();
  core.events.on('items-changed', ({ reason, ids }) => {
    if (reason !== 'status' && reason !== 'sync') return;
    for (const id of ids) {
      if (handled.has(id)) continue;
      let status: string;
      try {
        status = core.items.get(id).status;
      } catch {
        continue;
      }
      if (status === 'open') continue;
      handled.add(id);
      void workspace.cleanUpLeftItem(id).then(
        (done) => {
          if (!done.length) return;
          log('cleaned up after item left the list', { id, done });
          // Shown by the app: otherwise a kept checkout stays unnoticed (the PR left the list).
          core.events.emit('notice', {
            title: `Aufräumen: ${core.items.get(id).title}`,
            body: done.join('\n'),
          });
        },
        (err: unknown) =>
          log('cleanup after item left the list failed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }
  });
}
