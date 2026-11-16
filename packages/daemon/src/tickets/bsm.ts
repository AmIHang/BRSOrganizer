import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BSM_TICKET_BASE } from '@brsorganizer/core';
import { z } from 'zod';
import { htmlToText } from './html.js';

/** BSM serves its SPA and its API from here; nothing else is ever requested. */
export const BSM_ORIGIN = new URL(BSM_TICKET_BASE).origin;
export const BSM_WORKFLOW_PATH = '/api/core/web/runwf/';

/** The browser session has no (valid) BSM login: the API answered with the login page. */
export class BsmLoginRequiredError extends Error {
  constructor() {
    super('BSM: nicht angemeldet');
    this.name = 'BsmLoginRequiredError';
  }
}

/** HTTP access to BSM with the user's login (cookies). */
export interface BsmHttp {
  /** POST to the workflow API; the parsed JSON. Throws BsmLoginRequiredError without a session. */
  runWorkflow(body: unknown): Promise<unknown>;
  /** GET below BSM_ORIGIN (path starting with "/"), as bytes. */
  download(path: string): Promise<Uint8Array>;
}

/** Runs `fn` with a logged-in BSM connection (logging in first if needed) and cleans up after. */
export type BsmSession = <T>(fn: (http: BsmHttp) => Promise<T>) => Promise<T>;

/** "https://bsm.boomsoftware.com/indication/BRS_PWg0127" → "BRS_PWg0127"; null for other URLs. */
export function bsmKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== BSM_ORIGIN) return null;
  const m = /^\/indication\/([A-Za-z][A-Za-z0-9_]*\d+)\/?$/.exec(u.pathname);
  return m ? m[1]! : null;
}

/**
 * The ticket view, as the SPA requests it after /indication/<key>. The context names the ticket
 * (in clear text); WorkflowParameters only mirror the public URL.
 */
export function bsmTicketRequest(key: string) {
  return {
    ContextOPath: `|${key}|@BoomSupportManager.UI.IndicationIdentifier,BoomSupportManager.Core`,
    WorkflowType: 'External',
    WorkflowName: 'JumpToIndication',
    WorkflowParameters: { publicurl: `indication/${key}` },
  };
}

export interface BsmComment {
  author: string;
  at: Date | null;
  text: string;
  answers: BsmComment[];
}

export interface BsmImage {
  /** 1-based, as referenced in the text ("[Bild 2: …]"). */
  n: number;
  id: string;
  fileName: string;
}

export interface BsmTicket {
  key: string;
  url: string;
  title: string;
  /** Label/value pairs in display order (status, category, people, …); empty values left out. */
  fields: Array<[string, string]>;
  description: string;
  notes: string[];
  deliveries: string[];
  conversations: Array<{ topic: string; comments: BsmComment[] }>;
  images: BsmImage[];
}

type Node = Record<string, unknown>;

const responseSchema = z.object({
  ui: z.object({
    style: z.object({ title: z.string() }).partial().optional(),
    form: z.array(z.unknown()),
  }),
});

/** All objects of a form tree, depth-first in display order (children in `items` and `ui`). */
function nodes(root: unknown): Node[] {
  const out: Node[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Node;
      out.push(o);
      walk(o.items);
      walk(o.ui);
    }
  };
  walk(root);
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const title = (n: Node) => str((n.style as Node | undefined)?.title);

function parseDate(v: unknown): Date | null {
  const m = /Date\((-?\d+)/.exec(str(v));
  return m ? new Date(Number(m[1])) : null;
}

/** Extracts what matters for working on the ticket from the JumpToIndication response. */
export function parseBsmTicket(json: unknown, key: string): BsmTicket {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new Error('BSM: unerwartete Antwort (kein Ticket-Formular)');
  const all = nodes(parsed.data.ui.form);
  const feat = (f: string) => all.find((n) => n.feat === f);
  const value = (f: string) => str(feat(f)?.value);

  // Images: one number per document id, in order of first appearance.
  const images: BsmImage[] = [];
  // File names of attachments, from the description and from comments (and their answers).
  const knownNames = new Map<string, string>();
  const collect = (n: Node) => {
    if (Array.isArray(n.documents)) {
      for (const d of n.documents as Node[]) {
        if (str(d.id)) knownNames.set(str(d.id), str(d.fileName));
      }
    }
    for (const k of ['comments', 'answers']) {
      if (Array.isArray(n[k])) (n[k] as Node[]).forEach(collect);
    }
  };
  all.forEach(collect);
  const image = (src: string, alt: string) => {
    if (!src || /^(https?:|data:)/i.test(src)) return alt ? `[Bild: ${alt}]` : '[Bild]';
    let img = images.find((i) => i.id === src);
    if (!img) {
      img = { n: images.length + 1, id: src, fileName: knownNames.get(src) || alt || 'bild.png' };
      images.push(img);
    }
    return `[Bild ${img.n}: ${img.fileName}]`;
  };
  const text = (html: unknown) => htmlToText(str(html), image);

  const status = str(feat('cfProgressBar')?.status);
  // "BRS_PWg0155 |  In Bearbeitung: IH-Berechnung | Termine …" → "IH-Berechnung | Termine …"
  const fullTitle = str(parsed.data.ui.style?.title);
  const parts = fullTitle.split('|').map((p) => p.trim());
  if (parts[0] === key) parts.shift();
  if (parts[0] && status && parts[0].startsWith(`${status}:`)) {
    parts[0] = parts[0].slice(status.length + 1).trim();
  }

  const fields: Array<[string, string]> = [
    ['Status', status],
    ['Kategorie', value('Category')],
    ['Priorität', value('Priority')],
    ['Melder', value('Reporter')],
    ['Verantwortlich', value('cfHandlerText')],
    ['Betroffenes System', value('cfAffectedSystem').replace(/\s*\n\s*/g, '; ')],
    ['Bereich', value('ApplicationArea')],
    [
      'Tags',
      (Array.isArray(feat('cfAvailableTags')?.tags)
        ? (feat('cfAvailableTags')!.tags as Node[])
        : []
      )
        .map((t) => str(t.name))
        .filter(Boolean)
        .join(', '),
    ],
    ['Erstellt', value('CreateInfo')],
    ['Geändert', value('ChangeInfo')],
  ];

  const description = text(feat('Description')?.value);

  const notes = nodes(feat('cfAdditionalDescriptions')?.ui)
    .filter((n) => n.feat && str(n.value))
    .map((n) => text(n.value))
    .filter(Boolean);

  // Deliveries: every delivery object (its own context) with its labelled values.
  const deliveries: string[] = [];
  for (const [f, kind] of [
    ['cfPlannedSortedDeliveries', 'geplant'],
    ['cfDoneSortedDeliveries', 'geliefert'],
  ] as const) {
    const byContext = new Map<string, string[]>();
    for (const n of nodes(feat(f)?.ui)) {
      const v = str(n.value);
      if (!n.feat || !v || typeof n.context !== 'string') continue;
      const list = byContext.get(n.context) ?? [];
      list.push(title(n) ? `${title(n)}: ${v}` : v);
      byContext.set(n.context, list);
    }
    for (const list of byContext.values()) deliveries.push(`${kind} – ${list.join(', ')}`);
  }

  const conversations = nodes(feat('cfConversations')?.ui)
    .filter((n) => n.type === 'bfres!bsm-js://Conversation')
    .map((c) => {
      const users = new Map(
        (Array.isArray(c.users) ? (c.users as Node[]) : []).map((u) => [
          str(u.username),
          str(u.displayText),
        ]),
      );
      const comment = (cm: Node): BsmComment => ({
        author: users.get(str(cm.username)) || str(cm.username) || 'unbekannt',
        at: parseDate(cm.timestamp),
        text: text(cm.html),
        answers: (Array.isArray(cm.answers) ? (cm.answers as Node[]) : []).map(comment),
      });
      return {
        topic: str(c.value),
        comments: (Array.isArray(c.comments) ? (c.comments as Node[]) : []).map(comment),
      };
    })
    .filter((c) => c.comments.length > 0);

  return {
    key,
    url: `${BSM_TICKET_BASE}${key}`,
    title: parts.join(' | ') || fullTitle || key,
    fields: fields.filter(([, v]) => v),
    description,
    notes,
    deliveries,
    conversations,
    images,
  };
}

const VIENNA = new Intl.DateTimeFormat('de-AT', {
  timeZone: 'Europe/Vienna',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const formatDate = (d: Date) => VIENNA.format(d).replace(',', '');

const indent = (s: string, by: string) =>
  s
    .split('\n')
    .map((l) => (l ? by + l : l))
    .join('\n');

/** Upper bound for the ticket text in the agent prompt. */
export const BSM_MARKDOWN_LIMIT = 40_000;

/**
 * Markdown for the agent prompt. `files` maps image numbers to local files (downloaded images);
 * images without a file are only named.
 */
export function bsmTicketMarkdown(
  t: BsmTicket,
  fetchedAt: Date,
  files: ReadonlyMap<number, string> = new Map(),
): string {
  const out: string[] = [
    `### BSM-Ticket ${t.key}: ${t.title}`,
    '',
    `Quelle: ${t.url} (abgerufen ${formatDate(fetchedAt)})`,
    '',
    ...t.fields.map(([k, v]) => `- ${k}: ${v}`),
    ...t.deliveries.map((d) => `- Lieferung ${d}`),
    '',
    '#### Beschreibung',
    '',
    t.description || '(leer)',
  ];
  if (t.notes.length) out.push('', '#### Notizen', '', ...t.notes.flatMap((n) => [n, '']));
  if (t.conversations.length) {
    out.push('', '#### Themen und Kommentare');
    const comment = (c: BsmComment, depth: number): string[] => {
      const pad = '  '.repeat(depth);
      return [
        `${pad}- ${c.author}${c.at ? `, ${formatDate(c.at)}` : ''}:`,
        indent(c.text || '(leer)', `${pad}  `),
        ...c.answers.flatMap((a) => comment(a, depth + 1)),
      ];
    };
    for (const conv of t.conversations) {
      out.push(
        '',
        `Thema: ${conv.topic || '-'}`,
        '',
        ...conv.comments.flatMap((c) => comment(c, 0)),
      );
    }
  }
  if (t.images.length) {
    out.push('', '#### Bilder', '');
    for (const img of t.images) {
      const file = files.get(img.n);
      out.push(`- Bild ${img.n} (${img.fileName}): ${file ?? 'nicht heruntergeladen'}`);
    }
  }
  const md = out.join('\n').trim();
  return md.length > BSM_MARKDOWN_LIMIT
    ? `${md.slice(0, BSM_MARKDOWN_LIMIT)}\n\n… (gekürzt, vollständig unter ${t.url})`
    : md;
}

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ReadTicketResult {
  markdown: string;
  /** Downloaded attachments (absolute paths). */
  files: string[];
}

/**
 * Reads a BSM ticket through `session` and returns it as prompt Markdown. Images (screenshots in
 * the description and comments) are saved to `filesDir`, so the agent can look at them.
 */
export async function readBsmTicket(
  session: BsmSession,
  url: string,
  filesDir: string,
  now: () => Date,
): Promise<ReadTicketResult> {
  const key = bsmKey(url);
  if (!key) throw new Error(`BSM: keine Ticket-URL unter ${BSM_ORIGIN}: ${url}`);

  return session(async (http) => {
    const ticket = parseBsmTicket(await http.runWorkflow(bsmTicketRequest(key)), key);
    const fetchedAt = now();
    const files = new Map<number, string>();
    for (const img of ticket.images.slice(0, MAX_IMAGES)) {
      try {
        const bytes = await http.download(
          `/bfres/de/referenced-document/${encodeURIComponent(img.id)}/${encodeURIComponent(img.fileName)}`,
        );
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue;
        mkdirSync(filesDir, { recursive: true });
        const safe = img.fileName.replace(/[^\w.-]+/g, '_').slice(-80) || 'bild.png';
        const file = join(filesDir, `bsm-${img.n}-${safe}`);
        writeFileSync(file, bytes);
        files.set(img.n, file);
      } catch (err) {
        if (err instanceof BsmLoginRequiredError) throw err;
        // A missing image must not cost the ticket text.
      }
    }
    return { markdown: bsmTicketMarkdown(ticket, fetchedAt, files), files: [...files.values()] };
  });
}
