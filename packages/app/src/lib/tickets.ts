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
