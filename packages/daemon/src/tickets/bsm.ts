import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BSM_TICKET_BASE } from '@brsorganizer/core';
import { z } from 'zod';
import { htmlToText } from './html.js';

/** BSM serves its SPA and its API from here; nothing else is ever requested. */
export const BSM_ORIGIN = new URL(BSM_TICKET_BASE).origin;
export const BSM_WORKFLOW_PATH = '/api/core/web/runwf/';

/** The browser session has no (valid) BSM/OTMA login: the API answered with the login page. */
export class BsmLoginRequiredError extends Error {
  constructor(label: 'BSM' | 'OTMA' = 'BSM') {
    super(`${label}: nicht angemeldet`);
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

/** A file in the ticket's document list (attachments and pasted images). */
export interface BsmAttachment {
  /** Object path of the document: what the download workflow is run on. */
  opath: string;
  name: string;
  /** Display type, e.g. "PNG-Datei". */
  type: string;
  author: string;
  at: Date | null;
}

/** A BSM or OTMA ticket, as it goes into the agent's task. */
export interface BsmTicket {
  system: 'BSM' | 'OTMA';
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
  attachments: BsmAttachment[];
}

export type Node = Record<string, unknown>;

const responseSchema = z.object({
  ui: z.object({
    style: z.object({ title: z.string() }).partial().optional(),
    form: z.array(z.unknown()),
  }),
});

/** All objects of a form tree, depth-first in display order (children in `items` and `ui`). */
export function nodes(root: unknown): Node[] {
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

export const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
export const title = (n: Node) => str((n.style as Node | undefined)?.title);

export function parseDate(v: unknown): Date | null {
  const m = /Date\((-?\d+)/.exec(str(v));
  return m ? new Date(Number(m[1])) : null;
}

/**
 * HTML fields (description, comments) as text; pasted images become numbered references
 * ("[Bild 2: …]") collected in `images`, with file names from the documents of all nodes.
 */
export function richText(all: Node[]): { images: BsmImage[]; text: (html: unknown) => string } {
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
  return { images, text: (html) => htmlToText(str(html), image) };
}

/** Extracts what matters for working on the ticket from the JumpToIndication response. */
export function parseBsmTicket(json: unknown, key: string): BsmTicket {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new Error('BSM: unerwartete Antwort (kein Ticket-Formular)');
  const all = nodes(parsed.data.ui.form);
  const feat = (f: string) => all.find((n) => n.feat === f);
  const value = (f: string) => str(feat(f)?.value);

  const { images, text } = richText(all);

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

  // Document list: a table of rows [{op}, nameIdx, typeIdx, authorIdx, dateIdx] with the texts in
  // `strings` (0-based) and the dates in `dates` (1-based).
  const attachments: BsmAttachment[] = [];
  const docs = feat('FilteredDocuments');
  const strings = Array.isArray(docs?.strings) ? (docs.strings as unknown[]) : [];
  const dates = Array.isArray(docs?.dates) ? (docs.dates as unknown[]) : [];
  for (const row of Array.isArray(docs?.data) ? (docs.data as unknown[]) : []) {
    if (!Array.isArray(row)) continue;
    const opath = str((row[0] as Node | undefined)?.op);
    if (!/^\*[\w-]{4,200}$/.test(opath)) continue;
    const text = (i: unknown) => (typeof i === 'number' ? str(strings[i]) : '');
    const ms = typeof row[4] === 'number' ? dates[row[4] - 1] : undefined;
    attachments.push({
      opath,
      name: text(row[1]) || 'Anhang',
      type: text(row[2]),
      author: text(row[3]),
      at: typeof ms === 'number' ? new Date(ms) : null,
    });
  }

  return {
    system: 'BSM',
    key,
    url: `${BSM_TICKET_BASE}${key}`,
    title: parts.join(' | ') || fullTitle || key,
    fields: fields.filter(([, v]) => v),
    description,
    notes,
    deliveries,
    conversations,
    images,
    attachments,
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

/** Local copies of a ticket's files, for the prompt. */
export interface BsmFiles {
  /** Image number -> downloaded file. */
  images?: ReadonlyMap<number, string>;
  /** Attachments that are not one of the images, with their file (null: not downloaded). */
  attachments?: ReadonlyArray<{ attachment: BsmAttachment; file: string | null }>;
}

/** Markdown for the agent prompt; files without a local copy are only named. */
export function ticketMarkdown(t: BsmTicket, fetchedAt: Date, files: BsmFiles = {}): string {
  const images = files.images ?? new Map<number, string>();
  const out: string[] = [
    `### ${t.system}-Ticket ${t.key}: ${t.title}`,
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
      const file = images.get(img.n);
      out.push(`- Bild ${img.n} (${img.fileName}): ${file ?? 'nicht heruntergeladen'}`);
    }
  }
  if (files.attachments?.length) {
    out.push('', '#### Anhänge', '');
    files.attachments.forEach(({ attachment: a, file }, i) => {
      const meta = [a.type, a.author, a.at ? formatDate(a.at) : ''].filter(Boolean).join(', ');
      out.push(
        `- Anhang ${i + 1} (${a.name}${meta ? `; ${meta}` : ''}): ${file ?? 'nicht heruntergeladen'}`,
      );
    });
  }
  const md = out.join('\n').trim();
  return md.length > BSM_MARKDOWN_LIMIT
    ? `${md.slice(0, BSM_MARKDOWN_LIMIT)}\n\n… (gekürzt, vollständig unter ${t.url})`
    : md;
}

const MAX_IMAGES = 10;
const MAX_ATTACHMENTS = 15;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const downloadSchema = z.object({
  download: z.string().regex(/^[\w-]{8,100}$/),
  download_fileextension: z.string().optional(),
});

/** What the SPA runs for "Öffnen" on a document: answers with a download token. */
export function bsmDocumentRequest(opath: string) {
  return {
    ContextOPath: opath,
    WorkflowType: 'View',
    TransactionBehavior: 'NoTransaction',
    WorkflowParameters: {},
  };
}

const safeName = (name: string) =>
  name
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-80) || 'datei';

export interface ReadTicketResult {
  markdown: string;
  /** Downloaded images and attachments (absolute paths). */
  files: string[];
}

/**
 * Reads a BSM ticket through `session` and returns it as prompt Markdown. Images (screenshots in
 * the description and comments) and attachments are saved to `filesDir`, so the agent can open
 * them; attachments that are just copies of an image are listed only once.
 */
export async function readBsmTicket(
  session: BsmSession,
  url: string,
  filesDir: string,
  now: () => Date,
): Promise<ReadTicketResult> {
  const key = bsmKey(url);
  if (!key) throw new Error(`BSM: keine Ticket-URL unter ${BSM_ORIGIN}: ${url}`);

  return session(async (http) =>
    saveTicket(
      http,
      parseBsmTicket(await http.runWorkflow(bsmTicketRequest(key)), key),
      filesDir,
      now(),
    ),
  );
}

/**
 * Downloads the ticket's images and attachments to `filesDir` (same file API on BSM and OTMA)
 * and renders the prompt Markdown with their paths.
 */
export async function saveTicket(
  http: BsmHttp,
  ticket: BsmTicket,
  filesDir: string,
  fetchedAt: Date,
): Promise<ReadTicketResult> {
  const written: string[] = [];
  const save = (name: string, bytes: Uint8Array) => {
    mkdirSync(filesDir, { recursive: true });
    const file = join(filesDir, name);
    writeFileSync(file, bytes);
    written.push(file);
    return file;
  };
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  // A missing file must not cost the ticket text; only a lost login ends the read.
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BsmLoginRequiredError) throw err;
      return null;
    }
  };

  const images = new Map<number, string>();
  const imageHashes = new Set<string>();
  for (const img of ticket.images.slice(0, MAX_IMAGES)) {
    const bytes = await attempt(() =>
      http.download(
        `/bfres/de/referenced-document/${encodeURIComponent(img.id)}/${encodeURIComponent(img.fileName)}`,
      ),
    );
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) continue;
    imageHashes.add(hash(bytes));
    images.set(
      img.n,
      save(`${ticket.system.toLowerCase()}-${img.n}-${safeName(img.fileName)}`, bytes),
    );
  }

  const attachments: Array<{ attachment: BsmAttachment; file: string | null }> = [];
  let downloaded = 0;
  for (const a of ticket.attachments) {
    if (downloaded >= MAX_ATTACHMENTS) {
      attachments.push({ attachment: a, file: null });
      continue;
    }
    const got = await attempt(async () => {
      const link = downloadSchema.parse(await http.runWorkflow(bsmDocumentRequest(a.opath)));
      const ext = /^\.[A-Za-z0-9]{1,8}$/.test(link.download_fileextension ?? '')
        ? link.download_fileextension!
        : '';
      return { ext, bytes: await http.download(`/api/core/web/dl/${link.download}`) };
    });
    if (!got || got.bytes.byteLength === 0 || got.bytes.byteLength > MAX_FILE_BYTES) {
      attachments.push({ attachment: a, file: null });
      continue;
    }
    if (imageHashes.has(hash(got.bytes))) continue; // already there as "Bild n"
    downloaded++;
    const n = attachments.length + 1;
    const name =
      got.ext && !a.name.toLowerCase().endsWith(got.ext.toLowerCase()) ? a.name + got.ext : a.name;
    attachments.push({ attachment: a, file: save(`anhang-${n}-${safeName(name)}`, got.bytes) });
  }

  return {
    markdown: ticketMarkdown(ticket, fetchedAt, { images, attachments }),
    files: written,
  };
}
