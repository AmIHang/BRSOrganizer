import { api } from './api';
import type { Item, OtmaTicket, Settings } from './types';

/** Learned ticket → project mappings (settings.workspace). */
export type ProjectMaps = Pick<Settings['workspace'], 'otmaProjects' | 'bsmProjects'>;

const lastSegment = (input: string) => input.trim().replace(/\/+$/, '').split('/').pop() ?? '';

/** Customer ID of a BSM ticket "<customer><lowercase letter><number>": everything before the last lowercase letter. */
export function bsmPrefix(input: string): string | null {
  return /^(.+)[a-z][^a-z]*$/.exec(lastSegment(input))?.[1] ?? null;
}

/**
 * The OTMA ticket behind a typed number or URL.
 * shortcut: only tickets in the loaded OTMA list are known (a per-ticket fetch may open the login).
 */
export function findOtma(input: string): OtmaTicket | undefined {
  const key = lastSegment(input).replace(/^#/, '');
  return key ? otma.tickets?.find((t) => t.key === key) : undefined;
}

/**
 * Project the BSM customer of the tickets maps to (typed BSM ticket, or the one the OTMA ticket
 * links). The daemon learns the mapping whenever a todo or PR with a BSM ticket has a project,
 * and applies it itself to todos without one; the dialogs only preselect it.
 */
export function suggestProject(
  bsm: string,
  t: OtmaTicket | undefined,
  maps: ProjectMaps,
): { project: string; via: string } | null {
  const prefix = bsmPrefix(bsm) ?? bsmPrefix(t?.bsm ?? '');
  const project = prefix ? maps.bsmProjects[prefix] : undefined;
  return project ? { project, via: `BSM-Kunde „${prefix}“` } : null;
}

/** Takes an OTMA ticket over as a todo in `project` (customer folder, '' = none). */
export async function otmaToTodo(t: OtmaTicket, project: string): Promise<Item> {
  const todo = await api.addTodo({ title: t.title, otmaUrl: t.url, bsmUrl: t.bsm || null });
  return project ? await api.updateTodo(todo.id, { project }) : todo;
}

/** Ticket numbers the user has seen in the OTMA tab (kept per installation). */
const SEEN_KEY = 'brsorganizer.otma-seen';
/** Ignored tickets: number → change date when ignored. */
const IGNORED_KEY = 'brsorganizer.otma-ignored';
const ENABLED_KEY = 'brsorganizer.otma-enabled';

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const storedSeen = load<string[]>(SEEN_KEY);
let seen = storedSeen ? new Set(storedSeen) : null;
let visible = false;

function markSeen(tickets: OtmaTicket[]) {
  // Only the current list: tickets that dropped out are forgotten.
  seen = new Set(tickets.map((t) => t.key));
  localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
}

export const otma = $state({
  tickets: null as OtmaTicket[] | null,
  loading: false,
  error: null as string | null,
  /** Not yet seen in the tab: the count on the tab's bubble. */
  unseen: [] as string[],
  /** New when the tab was opened: highlighted until the tab is left. */
  highlighted: [] as string[],
  ignored: load<Record<string, string | null>>(IGNORED_KEY) ?? {},
  /** OTMA tab shown (settings); off: no tab and no background loads. */
  enabled: load<boolean>(ENABLED_KEY) ?? true,
});

export function setOtmaEnabled(on: boolean) {
  otma.enabled = on;
  localStorage.setItem(ENABLED_KEY, JSON.stringify(on));
}

/** Ignores every ticket of the last list. */
export function ignoreAllOtma() {
  const all = { ...otma.ignored };
  for (const t of otma.tickets ?? []) all[t.key] = t.changedAt;
  saveIgnored(all);
}

export function unignoreAllOtma() {
  saveIgnored({});
}

function saveIgnored(ignored: Record<string, string | null>) {
  otma.ignored = ignored;
  localStorage.setItem(IGNORED_KEY, JSON.stringify(ignored));
}

export function ignoreOtma(t: OtmaTicket) {
  saveIgnored({ ...otma.ignored, [t.key]: t.changedAt });
}

export function unignoreOtma(key: string) {
  const rest = { ...otma.ignored };
  delete rest[key];
  saveIgnored(rest);
}

function update() {
  const tickets = otma.tickets ?? [];
  // Very first list: nothing counts as new.
  if (!seen) markSeen(tickets);
  const fresh = tickets.filter((t) => !seen!.has(t.key)).map((t) => t.key);
  if (visible && fresh.length) {
    otma.highlighted = [...otma.highlighted, ...fresh];
    markSeen(tickets);
    otma.unseen = [];
  } else otma.unseen = fresh;

  // Ignored only while unchanged: a new change date (or leaving the list) ends it.
  const changed = new Map(tickets.map((t) => [t.key, t.changedAt]));
  const kept = Object.fromEntries(
    Object.entries(otma.ignored).filter(([key, at]) => changed.has(key) && changed.get(key) === at),
  );
  if (Object.keys(kept).length !== Object.keys(otma.ignored).length) saveIgnored(kept);
}

/** Reads the list (may open the OTMA login window). */
export async function loadOtma() {
  if (otma.loading) return;
  otma.loading = true;
  try {
    otma.tickets = await api.otmaTickets();
    otma.error = null;
    update();
  } catch (e) {
    otma.error = e instanceof Error ? e.message : String(e);
  } finally {
    otma.loading = false;
  }
}

/** The tab is shown (true) or left (false). Opening it marks everything as seen. */
export function setOtmaVisible(on: boolean) {
  visible = on;
  if (on) {
    otma.highlighted = otma.unseen;
    otma.unseen = [];
    if (otma.tickets) markSeen(otma.tickets);
  } else otma.highlighted = [];
}
