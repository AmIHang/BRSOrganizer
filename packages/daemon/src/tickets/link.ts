import type { Core } from '@brsorganizer/core';
import { bsmKey, bsmOtmaNumber, type BsmSession } from './bsm.js';
import { otmaBsmKey, otmaKey, otmaView } from './otma.js';

/**
 * Todos and PRs with only one of the two tickets get the other one: the BSM ticket an OTMA ticket
 * links to, or the OTMA ticket of a BSM ticket's main work package. On creation and whenever the
 * tickets change; runs in the background (reading may need the login), a failure only leaves the
 * field empty.
 */
export function linkTickets(
  core: Core,
  sessions: { bsm: BsmSession; otma: BsmSession },
  log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
): void {
  // Ticket pair last looked up per item: other edits of the item read nothing again.
  const looked = new Map<string, string>();
  core.events.on('items-changed', ({ reason, actor, ids }) => {
    if ((reason !== 'created' && reason !== 'updated') || actor === 'sync') return;
    for (const id of ids) {
      const item = core.items.get(id);
      if (item.type !== 'todo' && item.type !== 'pr') continue;
      const pair = `${item.bsmUrl ?? ''}|${item.otmaUrl ?? ''}`;
      if (looked.get(id) === pair) continue;
      looked.set(id, pair);

      const otma = !item.bsmUrl && item.otmaUrl ? otmaKey(item.otmaUrl) : null;
      const bsm = !item.otmaUrl && item.bsmUrl ? bsmKey(item.bsmUrl) : null;
      const lookup: Promise<{ bsmUrl?: string | null; otmaUrl?: string | null }> | null = otma
        ? sessions.otma(async (http) => ({ bsmUrl: otmaBsmKey(await otmaView(http, otma)) }))
        : bsm
          ? sessions.bsm(async (http) => ({ otmaUrl: await bsmOtmaNumber(http, bsm) }))
          : null;
      void lookup
        ?.then(({ bsmUrl, otmaUrl }) => {
          const now = core.items.get(id);
          // Only if nobody changed the tickets in the meantime.
          if (`${now.bsmUrl ?? ''}|${now.otmaUrl ?? ''}` !== pair) return;
          if (bsmUrl) core.items.setTickets(id, { bsmUrl }, actor);
          if (otmaUrl) core.items.setTickets(id, { otmaUrl }, actor);
        })
        .catch((err: unknown) =>
          log('could not look up the other ticket', {
            id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
  });
}
