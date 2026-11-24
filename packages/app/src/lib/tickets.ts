import type { Item } from './types';

/** Label for a ticket bubble: the last path segment, e.g. ".../indication/BRS_PWg0127" -> "BRS_PWg0127". */
export function ticketLabel(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last ?? u.host);
  } catch {
    return url;
  }
}

/**
 * Open PRs that already cover a ticket (BSM: linked, or named in title/branch as the agent does;
 * OTMA: linked), so a second todo for the same work does not go unnoticed.
 */
export function openPrsForTicket(
  items: Item[],
  bsm: string | null | undefined,
  otma: string | null | undefined,
): Item[] {
  const key = (v: string | null | undefined) =>
    v?.trim() ? ticketLabel(v.trim().replace(/\/+$/, '')).replace(/^#/, '').toLowerCase() : null;
  const b = key(bsm);
  const o = key(otma);
  // Whole key only: FTBRSg0052 is not FTBRSg00521 (same rule as the sync's adoption).
  const named = b && /^[a-z0-9_-]+$/.test(b) ? new RegExp(`(^|[^a-z0-9])${b}(?![0-9])`, 'i') : null;
  return items.filter(
    (p) =>
      p.type === 'pr' &&
      p.status === 'open' &&
      ((b !== null && key(p.bsmUrl) === b) ||
        (o !== null && key(p.otmaUrl) === o) ||
        (named !== null &&
          (named.test(p.title) || named.test(String(p.meta?.sourceBranch ?? ''))))),
  );
}
