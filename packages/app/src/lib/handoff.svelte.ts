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

/** analysis: analyse the tickets and propose a solution; implement: also implement it and open a PR. */
export type AgentWork = 'analysis' | 'implement';

interface AgentModeState {
  on: boolean;
  work: AgentWork;
  pending: string[];
}

function loadAgentMode(): AgentModeState {
  const state: AgentModeState = { on: false, work: 'analysis', pending: [] };
  try {
    const raw = localStorage.getItem(AGENT_MODE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw) as Partial<AgentModeState>);
  } catch {
    // storage unavailable or garbled: start switched off
  }
  return state;
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

export function setAgentWork(work: AgentWork): void {
  agentMode.work = work;
  saveAgentMode();
}

export function setAgentMode(on: boolean): void {
  agentMode.on = on;
  if (!on) agentMode.pending = [];
  saveAgentMode();
}

/** A todo was just created. */
export function agentModeCreated(item: Item): void {
  if (!agentMode.on || item.type !== 'todo') return;
  if (typeof item.meta?.project === 'string') void startHandOff(item, agentMode.work);
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
  if (agentMode.on && typeof item.meta?.project === 'string') void startHandOff(item, agentMode.work);
}

/** `work` from the agent mode; without it the todo's instruction decides (manual "An Claude"). */
export async function startHandOff(item: Item, work?: AgentWork): Promise<void> {
  if (handOffs[item.id]?.running) return;
  handOffs[item.id] = {
    running: true,
    text: item.bsmUrl || item.otmaUrl ? 'Lese Tickets …' : 'Starte Agent …',
    error: false,
  };
  let done: HandOffState;
  try {
    const r = await api.pr.handOffTodo(item.id, work);
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
