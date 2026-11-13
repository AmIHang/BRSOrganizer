import type { Clock } from '../clock.js';
import type { ExternalItem, SyncSource } from './engine.js';

/**
 * Pull requests from Azure DevOps Server notification mails (e.g. an Outlook folder "PR").
 *
 * Mail format (German Azure DevOps Server):
 *   Subject: "PR – <title> – <repo> <id> (<author>)"
 *   Body, first line: "<Name> hat den Pull Request abgeschlossen." etc.
 *   Links: (Safelinks-wrapped) https://<host>/tfs/<collection>/<project>/_git/<repo>/pullrequest/<id>
 *
 * A PR is open unless a mail says it was completed, or the latest abandon/reactivate mail is an
 * abandon. Mails can arrive out of order (an auto-completed PR sends "abgeschlossen" before
 * "erstellt"), so completion wins regardless of order.
 */

export interface PrMail {
  /** ISO timestamp. */
  receivedAt: string;
  subject: string;
  /** Plain-text body (the beginning is enough). */
  body: string;
  /** href targets from the HTML body. */
  urls: string[];
}

export interface PrMailbox {
  /** Display name of the mailbox owner (e.g. "Grantner Dorian"), used for "is it me". */
  me: string | null;
  mails: PrMail[];
}

export type PrMailEvent =
  | 'created'
  | 'completed'
  | 'abandoned'
  | 'reactivated'
  | 'reviewer-added'
  | 'reviewer-removed'
  | 'published'
  | 'pushed'
  | 'autocomplete-set'
  | 'autocomplete-cancelled'
  | 'other';

const EVENT_PATTERNS: Array<[PrMailEvent, RegExp]> = [
  ['completed', /hat den Pull Request abgeschlossen|completed the pull request/i],
  ['abandoned', /hat den Pull Request aufgegeben|abandoned the pull request/i],
  ['reactivated', /hat den Pull Request reaktiviert|reactivated the pull request/i],
  ['created', /hat einen neuen Pull Request erstellt|created a new pull request/i],
  ['reviewer-removed', /als Reviewer entfernt|removed as (a )?reviewer/i],
  ['reviewer-added', /als Reviewer hinzugefügt|added as (a )?reviewer/i],
  ['published', /hat den Pull Request veröffentlicht|published the pull request/i],
  ['pushed', /mithilfe von Push übertragen|pushed new changes/i],
  [
    'autocomplete-cancelled',
    /automatische Vervollständigung abgebrochen|cancell?ed auto-?complete/i,
  ],
  ['autocomplete-set', /automatische Vervollständigung festgelegt|set auto-?complete/i],
];

export function firstLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  );
}

export function classifyMail(body: string): PrMailEvent {
  const line = firstLine(body);
  return EVENT_PATTERNS.find(([, re]) => re.test(line))?.[0] ?? 'other';
}

export interface PrRef {
  /** Canonical PR URL without query string. */
  url: string;
  host: string;
  /** Collection (server) or organization (cloud). */
  collection: string;
  project: string;
  repo: string;
  id: number;
}

const PR_URL =
  /^(https?:\/\/([^/]+)\/(?:tfs\/)?([^/]+)\/([^/]+)\/_git\/([^/?#]+)\/pullrequest\/(\d+))/i;

/** Unwraps Outlook Safelinks and returns the canonical PR URL, if the link points to a PR. */
export function parsePrUrl(raw: string): PrRef | null {
  let url = raw.replace(/&amp;/g, '&');
  try {
    const u = new URL(url);
    if (/safelinks\.protection\.outlook\.com$/i.test(u.hostname)) {
      url = u.searchParams.get('url') ?? '';
    }
  } catch {
    return null;
  }
  const m = PR_URL.exec(url);
  if (!m) return null;
  return {
    url: m[1]!,
    host: m[2]!.toLowerCase(),
    collection: decodeURIComponent(m[3]!),
    project: decodeURIComponent(m[4]!),
    repo: decodeURIComponent(m[5]!),
    id: Number(m[6]),
  };
}

export interface SubjectInfo {
  title: string;
  repo: string;
  id: number;
  author: string | null;
}

/** "PR – <title> – <repo> <id> (<author>)"; the title itself may contain dashes. */
export function parseSubject(subject: string): SubjectInfo | null {
  const m = /^\s*PR\s+[–-]\s+(.*)\s+[–-]\s+(\S+)\s+(\d+)(?:\s+\((.*)\))?\s*$/.exec(subject);
  if (!m) return null;
  return { title: m[1]!.trim(), repo: m[2]!, id: Number(m[3]), author: m[4]?.trim() || null };
}

/** The body repeats the title right after the event line, often less truncated than the subject. */
function bodyTitle(body: string): string | null {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('<') && !/Azure DevOps/i.test(l));
  return lines[1] ?? null;
}

const stripEllipsis = (s: string) => s.replace(/\s*(\.\.\.|…)\s*$/, '');

function bestTitle(candidates: Array<string | null | undefined>): string {
  // Prefer the longest non-truncated text; a truncated one only if nothing else exists.
  const clean = candidates.filter((c): c is string => !!c && c.trim().length > 0);
  const full = clean.filter((c) => !/(\.\.\.|…)\s*$/.test(c));
  const pick = (list: string[]) => list.sort((a, b) => b.length - a.length)[0];
  return stripEllipsis(pick(full) ?? pick(clean) ?? '(untitled pull request)');
}

/** Turns a mailbox snapshot into the currently open PRs. */
export function openPrsFromMails(mailbox: PrMailbox): ExternalItem[] {
  const me = mailbox.me?.trim().toLowerCase() || null;

  interface Group {
    ref: PrRef | null;
    subject: SubjectInfo | null;
    titles: Array<string | null>;
    events: Array<{ event: PrMailEvent; at: number; line: string }>;
  }
  const groups = new Map<string, Group>();

  for (const mail of mailbox.mails) {
    const ref = mail.urls.map(parsePrUrl).find((r): r is PrRef => r !== null) ?? null;
    const subject = parseSubject(mail.subject);
    if (!ref && !subject) continue; // not a PR notification

    const key = ref
      ? `${ref.host}/${ref.collection}/${ref.project}/${ref.repo}/${ref.id}`.toLowerCase()
      : `subject/${subject!.repo}/${subject!.id}`.toLowerCase();
    const group = groups.get(key) ?? { ref: null, subject: null, titles: [], events: [] };
    group.ref ??= ref;
    group.subject ??= subject;
    group.titles.push(subject?.title ?? null, bodyTitle(mail.body));
    group.events.push({
      event: classifyMail(mail.body),
      at: Date.parse(mail.receivedAt),
      line: firstLine(mail.body).toLowerCase(),
    });
    groups.set(key, group);
  }

  const out: ExternalItem[] = [];
  for (const [key, g] of groups) {
    if (g.events.some((e) => e.event === 'completed')) continue;
    const lifecycle = g.events
      .filter((e) => e.event === 'abandoned' || e.event === 'reactivated')
      .sort((a, b) => a.at - b.at);
    if (lifecycle.at(-1)?.event === 'abandoned') continue;

    const author = g.subject?.author ?? null;
    const reasons: string[] = [];
    if (me) {
      const reviewerChanges = g.events
        .filter(
          (e) =>
            (e.event === 'reviewer-added' || e.event === 'reviewer-removed') && e.line.includes(me),
        )
        .sort((a, b) => a.at - b.at);
      // On my own PR my reviewer entry is self-added bookkeeping, not a review request.
      if (author && author.toLowerCase() === me) reasons.push('authored');
      else if (reviewerChanges.at(-1)?.event === 'reviewer-added') reasons.push('review-requested');
    }
    if (reasons.length === 0) reasons.push('notified');

    const repo = g.ref?.repo ?? g.subject?.repo ?? null;
    const number = g.ref?.id ?? g.subject?.id ?? null;
    out.push({
      externalId: key,
      type: 'pr',
      title: bestTitle(g.titles),
      link: g.ref?.url ?? null,
      meta: {
        repo,
        number,
        project: g.ref?.project ?? null,
        author,
        reasons,
        lastMailAt: new Date(Math.max(...g.events.map((e) => e.at))).toISOString(),
      },
    });
  }
  return out;
}

export type MailboxReader = (options: {
  folderPath: string;
  lookBackDays: number;
}) => Promise<PrMailbox>;

export interface MailPrSourceOptions {
  reader: MailboxReader;
  folderPath: string;
  lookBackDays: number;
  clock: Clock;
}

/**
 * Fallback for the TFS API source: same source id and external ids, so a PR keeps its item
 * when the user switches between mail and API.
 */
export class MailPrSource implements SyncSource {
  readonly id = 'tfs' as const;

  constructor(private readonly options: MailPrSourceOptions) {}

  async fetchSnapshot(): Promise<ExternalItem[]> {
    const mailbox = await this.options.reader({
      folderPath: this.options.folderPath,
      lookBackDays: this.options.lookBackDays,
    });
    // Defensive: the reader already limits the window, but tests and other readers may not.
    const cutoff = this.options.clock.now().getTime() - this.options.lookBackDays * 86_400_000;
    return openPrsFromMails({
      me: mailbox.me,
      mails: mailbox.mails.filter((m) => Date.parse(m.receivedAt) >= cutoff),
    });
  }
}
