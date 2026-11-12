import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { upcomingEvents } from './group';
import type { Item } from './types';

const REMINDER_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'amineeded.notified';

let permission: Promise<boolean> | null = null;

function allowed(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  })().catch(() => false);
  return permission;
}

/** Remembers what was announced so a restart does not repeat toasts. */
function notified(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function remember(keys: string[]): void {
  const all = [...notified(), ...keys].slice(-500);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

async function toast(title: string, body: string): Promise<void> {
  if (await allowed()) sendNotification({ title, body });
}

/** New items from a sync: a toast for every new review request. */
export async function announceNewItems(items: Item[]): Promise<void> {
  const seen = notified();
  const fresh = items.filter(
    (i) =>
      i.type === 'pr' &&
      Array.isArray(i.meta?.reasons) &&
      (i.meta.reasons as string[]).includes('review-requested') &&
      !seen.has(`pr:${i.id}`),
  );
  for (const pr of fresh) {
    const ref = pr.meta?.repo ? `${String(pr.meta.repo)}#${String(pr.meta.number ?? '')}` : '';
    await toast('Review angefragt', ref ? `${ref}: ${pr.title}` : pr.title);
  }
  remember(fresh.map((i) => `pr:${i.id}`));
}

/** Reminder shortly before an event starts (checked periodically by the UI). */
export async function remindUpcoming(items: Item[], now: Date): Promise<void> {
  const seen = notified();
  const due = upcomingEvents(items, now, REMINDER_MS).filter(
    (e) => !seen.has(`event:${e.id}:${e.startsAt}`),
  );
  for (const e of due) {
    const minutes = Math.max(1, Math.round((Date.parse(e.startsAt!) - now.getTime()) / 60_000));
    await toast(`In ${minutes} Min.`, e.title);
  }
  remember(due.map((e) => `event:${e.id}:${e.startsAt}`));
}
