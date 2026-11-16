import { api } from './api';
import type { Item } from './types';

export interface HandOffState {
  running: boolean;
  text: string;
  error: boolean;
}

/**
 * Hand-offs to the Claude agent, per item. Kept outside the row: choosing the project moves the
 * todo into another list group, which re-creates its row while the hand-off is still running.
 */
export const handOffs = $state<Record<string, HandOffState>>({});

export async function startHandOff(item: Item): Promise<void> {
  if (handOffs[item.id]?.running) return;
  handOffs[item.id] = {
    running: true,
    text: item.bsmUrl ? 'Lese BSM-Ticket …' : 'Starte Agent …',
    error: false,
  };
  let done: HandOffState;
  try {
    const r = await api.pr.handOffTodo(item.id);
    const failed = r.tickets.find((t) => !t.ok);
    done = failed
      ? {
          running: false,
          text: `Agent läuft (${r.branch}), aber ohne BSM-Inhalt – nur Link übergeben: ${failed.message ?? 'Fehler'}`,
          error: true,
        }
      : { running: false, text: `Agent läuft im PowerShell-Fenster (${r.branch}).`, error: false };
  } catch (e) {
    done = { running: false, text: e instanceof Error ? e.message : String(e), error: true };
  }
  handOffs[item.id] = done;
  setTimeout(
    () => {
      if (handOffs[item.id] === done) delete handOffs[item.id];
    },
    done.error ? 10_000 : 6_000,
  );
}
