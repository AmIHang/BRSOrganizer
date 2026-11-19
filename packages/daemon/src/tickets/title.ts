import type { Core, Item } from '@brsorganizer/core';
import { bsmKey, bsmTicketRequest, parseBsmTicket, type BsmSession } from './bsm.js';
import { otmaKey, otmaView, parseOtmaTicket } from './otma.js';

/** "BRS_PWg0127", "#148082" or a ticket URL (as typed, before validation) → its key. */
function keyOf(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  return input.trim().replace(/\/+$/, '').split('/').pop()?.replace(/^#/, '') || null;
}

/**
 * Title of a todo created without one, until the ticket's own title is read: its ticket key.
 * Takes the tickets as typed; the core validates them when the todo is added.
 */
export function placeholderTitle(bsmUrl: unknown, otmaUrl: unknown): string | null {
  const bsm = keyOf(bsmUrl);
  if (bsm) return bsm;
  const otma = keyOf(otmaUrl);
  return otma ? `OTMA ${otma}` : null;
}

/**
 * Replaces the placeholder title of `todo` with the title of its BSM ticket (fallback: the OTMA
 * ticket). Runs in the background (reading may need the login); a failure keeps the placeholder,
 * and a title the user changed in the meantime is never overwritten.
 */
export async function fillTicketTitle(
  core: Core,
  todo: Item,
  sessions: { bsm?: BsmSession; otma?: BsmSession },
  log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
): Promise<void> {
  const bsm = todo.bsmUrl ? bsmKey(todo.bsmUrl) : null;
  const otma = todo.otmaUrl ? otmaKey(todo.otmaUrl) : null;
  const read = async (): Promise<string | null> => {
    if (bsm && sessions.bsm) {
      try {
        return await sessions.bsm(async (http) =>
          parseBsmTicket(await http.runWorkflow(bsmTicketRequest(bsm)), bsm).title.trim(),
        );
      } catch (err) {
        log('could not read the BSM ticket title', { id: todo.id, error: String(err) });
      }
    }
    if (otma && sessions.otma) {
      return sessions.otma(async (http) =>
        parseOtmaTicket(await otmaView(http, otma), otma).title.trim(),
      );
    }
    return null;
  };
  try {
    const title = (await read())?.slice(0, 500);
    if (title && core.items.get(todo.id).title === todo.title) {
      core.items.updateTodo(todo.id, { title }, 'user');
    }
  } catch (err) {
    log('could not read the ticket title', { id: todo.id, error: String(err) });
  }
}
