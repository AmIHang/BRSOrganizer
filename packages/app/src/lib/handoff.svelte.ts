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

const AGENT_MODE_KEY = 'brsorganizer.agent-mode';

function loadAgentMode(): { on: boolean; pending: string[] } {
  try {
    const raw = localStorage.getItem(AGENT_MODE_KEY);
    if (raw) return JSON.parse(raw) as { on: boolean; pending: string[] };
  } catch {
    // storage unavailable or garbled: start switched off
  }
  return { on: false, pending: [] };
}

/**
 * Agent mode (switch in the header): new todos go to Claude on their own, right away with a
 * project, else as soon as they get one (`pending`). Kept per installation like the pin.
 */
export const agentMode = $state(loadAgentMode());

function saveAgentMode() {
  try {
    localStorage.setItem(AGENT_MODE_KEY, JSON.stringify(agentMode));
  } catch {
    // not remembered
  }
}

export function setAgentMode(on: boolean): void {
  agentMode.on = on;
  if (!on) agentMode.pending = [];
  saveAgentMode();
}

/** A todo was just created. */
export function agentModeCreated(item: Item): void {
  if (!agentMode.on || item.type !== 'todo') return;
  if (typeof item.meta?.project === 'string') void startHandOff(item);
  else {
    agentMode.pending = [...agentMode.pending, item.id];
    saveAgentMode();
  }
}

/** A todo got a project: hands it off if it was created in agent mode without one. */
export function agentModeProjectSet(item: Item): void {
  if (!agentMode.pending.includes(item.id)) return;
  agentMode.pending = agentMode.pending.filter((id) => id !== item.id);
  saveAgentMode();
  if (agentMode.on && typeof item.meta?.project === 'string') void startHandOff(item);
}

export async function startHandOff(item: Item): Promise<void> {
  if (handOffs[item.id]?.running) return;
  handOffs[item.id] = {
    running: true,
    text: item.bsmUrl || item.otmaUrl ? 'Lese Tickets …' : 'Starte Agent …',
    error: false,
  };
  let done: HandOffState;
  try {
    const r = await api.pr.handOffTodo(item.id);
    const where =
      r.mode === 'background'
        ? `im Hintergrund (${r.branch}) – ansehen mit „claude attach ${r.session}“`
        : `im eigenen Fenster (${r.branch}), Hintergrund nicht möglich (Ordner nicht vertraut?)`;
    const failed = r.tickets.find((t) => !t.ok);
    done = failed
      ? {
          running: false,
          text: `Agent läuft ${where}, aber ohne ${failed.kind.toUpperCase()}-Inhalt – nur Link übergeben: ${failed.message ?? 'Fehler'}`,
          error: true,
        }
      : { running: false, text: `Agent läuft ${where}.`, error: false };
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
