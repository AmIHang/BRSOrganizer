import { OTMA_TICKET_BASE } from '@brsorganizer/core';
import { z } from 'zod';
import {
  nodes,
  richText,
  saveTicket,
  str,
  title,
  parseDate,
  type BsmAttachment,
  type BsmComment,
  type BsmHttp,
  type BsmSession,
  type BsmTicket,
  type ReadTicketResult,
} from './bsm.js';

/** OTMA serves its SPA and its API from here; nothing else is ever requested. */
export const OTMA_ORIGIN = new URL(OTMA_TICKET_BASE).origin;

/** "https://otma.boomsoftware.com/ap/178333" → "178333"; null for other URLs. */
export function otmaKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== OTMA_ORIGIN) return null;
  const m = /^\/ap\/(\d{1,10})\/?$/.exec(u.pathname);
  return m ? m[1]! : null;
}

/** First step, as the SPA runs it after /ap/<number>: answers with a link to the ticket view. */
export function otmaJumpRequest(key: string) {
  return {
    ContextOPath: `|${key}|@BoomCRM.UI.OrderProcessIdentifier,BoomCRM.Core`,
    WorkflowEntity: 'BoomCRM.UI.OrderProcessIdentifier,BoomCRM.core',
    WorkflowType: 'External',
    WorkflowName: 'JumpToOrderProcess',
    WorkflowParameters: { publicurl: `ap/${key}` },
  };
}

const jumpSchema = z.object({
  link: z.object({
    wf: z.object({
      contextopath: z.string().regex(/^[0-9A-F]{1,12}@[0-9A-F]{1,12}$/i),
      entity: z.literal('dotNetBF.Modules.Resources.OrderProcess'),
      type: z.literal('View'),
      args: z.object({ formname: z.string().regex(/^[\w-]{1,50}$/) }),
    }),
  }),
});

/** Second step: the ticket view the jump answer points to (read-only "View" workflow). */
export function otmaViewRequest(jump: unknown) {
  const parsed = jumpSchema.safeParse(jump);
  if (!parsed.success) throw new Error('OTMA: Ticket nicht gefunden (unerwartete Antwort)');
  const wf = parsed.data.link.wf;
  return {
    ContextOPath: wf.contextopath,
    WorkflowEntity: wf.entity,
    WorkflowType: wf.type,
    WorkflowParameters: { formname: wf.args.formname },
  };
}

/** Both steps: the ticket view for an OTMA ticket number. */
export async function otmaView(http: BsmHttp, key: string): Promise<unknown> {
  return http.runWorkflow(otmaViewRequest(await http.runWorkflow(otmaJumpRequest(key))));
}

const viewSchema = z.object({
  ui: z.object({
    style: z.object({ title: z.string() }).partial().optional(),
    form: z.array(z.unknown()),
  }),
});

/** Link texts OTMA shows instead of a value ("Release zuordnen", "Kein Ticket zugewiesen"). */
const PLACEHOLDER = /^(Kein .* zugewiesen\??|Release zuordnen)$/;

/** Extracts what matters for working on the ticket from the order process view. */
export function parseOtmaTicket(json: unknown, key: string): BsmTicket {
  const parsed = viewSchema.safeParse(json);
  if (!parsed.success) throw new Error('OTMA: unerwartete Antwort (kein Ticket-Formular)');
  const all = nodes(parsed.data.ui.form);
  const feat = (f: string) => all.find((n) => n.feat === f);
  const { images, text } = richText(all);

  const field = (f: string, fallback: string): [string, string] => {
    const n = feat(f);
    const v = str(n?.value);
    return [(n && title(n)) || fallback, PLACEHOLDER.test(v) ? '' : v];
  };
  const fields = [
    field('Status', 'Status'),
    field('cfResponsiblePersonDisplayText', 'Verantwortlich'),
    field('cfReporter', 'Reporter'),
    field('Project', 'Projekt'),
    field('cfSupportIDLink', 'BSM'),
    field('cfDevOpsWorkItemIdLink', 'DevOps WorkItem'),
    field('cfAssignReleaseLink', 'Release'),
    field('Worktime', 'Planzeit h'),
    field('WorktimeUndone', 'Offen h'),
    field('cfTimeRecordingsSumRecursive', 'Σ Ist h'),
  ];

  const notes = nodes(feat('cfAdditionalDescriptions')?.ui)
    .filter((n) => n.feat && str(n.value))
    .map((n) => text(n.value))
    .filter(Boolean);

  // Conversations: one section each; its comments are contexts with author, date and text.
  const conversations = all
    .filter(
      (n) => str((n.style as Record<string, unknown> | undefined)?.css) === 'otma-conversation',
    )
    .map((section) => {
      const byContext = new Map<string, BsmComment>();
      for (const n of nodes(section.items)) {
        if (typeof n.context !== 'string') continue;
        const c = byContext.get(n.context) ?? { author: '', at: null, text: '', answers: [] };
        if (n.feat === 'CombinedCreateBy') c.author = str(n.value).replace(/\s*-$/, '');
        else if (n.feat === 'CombinedCreateDate') c.at = parseDate(n.value);
        else if (n.feat === 'CommentText') c.text = text(n.value);
        else continue;
        byContext.set(n.context, c);
      }
      return {
        topic: title(section) === '-' ? '' : title(section),
        comments: [...byContext.values()]
          .filter((c) => c.text)
          .map((c) => ({ ...c, author: c.author || 'unbekannt' })),
      };
    })
    .filter((c) => c.comments.length > 0);

  // "178333 - #STBBRSg0034: Titel" → "#STBBRSg0034: Titel"
  const fullTitle = str(parsed.data.ui.style?.title);
  const name = str(feat('Name')?.value);
  return {
    system: 'OTMA',
    key,
    url: `${OTMA_TICKET_BASE}${key}`,
    title: name || fullTitle.replace(new RegExp(`^${key}\\s*-\\s*`), '') || key,
    fields: fields.filter(([, v]) => v),
    description: text(feat('Note')?.value),
    notes,
    deliveries: [],
    conversations,
    images,
    attachments: otmaDocuments(feat('Documents')),
  };
}

/**
 * The "Dokumente" list: rows [{op}, …cells] in the order of `columns` (Typ, Bezeichnung,
 * Erstelldatum), texts as 0-based indexes into `strings`, dates as 1-based indexes into `dates`.
 */
function otmaDocuments(list: Record<string, unknown> | undefined): BsmAttachment[] {
  if (!list) return [];
  const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);
  const strings = arr(list.strings);
  const dates = arr(list.dates);
  const columns = arr(list.columns).map((c) => str((c as Record<string, unknown>)?.name));
  const out: BsmAttachment[] = [];
  for (const row of arr(list.data)) {
    if (!Array.isArray(row)) continue;
    const opath = str((row[0] as Record<string, unknown> | undefined)?.op);
    if (!/^[0-9A-F]{1,12}@[0-9A-F]{1,12}$/i.test(opath)) continue;
    const cell = (column: string) => row[columns.indexOf(column) + 1];
    const text = (column: string) => {
      const i = cell(column);
      return typeof i === 'number' ? str(strings[i]) : '';
    };
    const d = cell('CreateDate');
    const ms = typeof d === 'number' ? dates[d - 1] : undefined;
    out.push({
      opath,
      name: text('Name') || 'Anhang',
      type: text('Type'),
      author: '',
      at: typeof ms === 'number' ? new Date(ms) : null,
    });
  }
  return out;
}

/**
 * Reads an OTMA ticket through `session` and returns it as prompt Markdown; pasted images are
 * saved to `filesDir`.
 */
export async function readOtmaTicket(
  session: BsmSession,
  url: string,
  filesDir: string,
  now: () => Date,
): Promise<ReadTicketResult> {
  const key = otmaKey(url);
  if (!key) throw new Error(`OTMA: keine Ticket-URL unter ${OTMA_ORIGIN}: ${url}`);
  return session(async (http) =>
    saveTicket(http, parseOtmaTicket(await otmaView(http, key), key), filesDir, now()),
  );
}

/** The BSM ticket key an OTMA ticket links to ("BSM" field), or null if it has none. */
export function otmaBsmKey(view: unknown): string | null {
  const parsed = viewSchema.safeParse(view);
  if (!parsed.success) throw new Error('OTMA: unerwartete Antwort (kein Ticket-Formular)');
  const v = str(nodes(parsed.data.ui.form).find((n) => n.feat === 'cfSupportIDLink')?.value);
  return /^[A-Za-z][A-Za-z0-9_-]*\d+$/.test(v) ? v : null;
}

/**
 * "Arbeitspakete" with "nur meine" set, as the OTMA start page asks for them (read-only View
 * workflow; the open statuses are OTMA's default filter).
 */
export const OTMA_MY_TICKETS_REQUEST = (() => {
  const main = {
    __type: 'BoomCRM.UI.Web.BoomCRMMain,BoomCRM.UI.Web',
    __opath: '|M|@BoomCRM.UI.Web.BoomCRMMain,BoomCRM.UI.Web',
    __roles: ['root'],
  };
  const list = {
    __type: 'BoomCRM.UI.Web.Search.OrderProcessSearchList,BoomCRM.UI.Web',
    __opath:
      '|OrderProcessSearchList_global_search-global|@BoomCRM.UI.Web.Search.OrderProcessSearchList,BoomCRM.UI.Web',
  };
  const expando = 'dotNetBF.Gui.GuiExpandoObject,bfsvclib';
  const dummy = { __type: expando, __opath: `|dummy|@${expando}`, __isref: false };
  const filter = {
    original: [{ ...dummy, __identity: [], __roles: [] }],
    modified: [
      {
        ...dummy,
        cfFilterCustomer: { __opath: null },
        cfFilterApplication: { __opath: null },
        cfFilterProject: { __opath: null },
        cfFilterOnlyMyOPs: true,
      },
    ],
    types: [
      { n: expando, b: 1, i: [2, 3, 4, 5, 6, 7, 8, 9] },
      { n: 'dotNetBF.Gui.GuiObject,bfsvclib', b: 10, i: [2, 3, 4, 5, 6, 7, 8, 9] },
      { n: 'dotNetBF.Core.Scripting.IEvalObject' },
      { n: 'dotNetBF.Core.Scripting.IEvalType' },
      { n: 'dotNetBF.Core.Scripting.IIntrinsicContext' },
      { n: 'dotNetBF.Core.Scripting.IExpandoObject' },
      { n: 'dotNetBF.Core.Scripting.IIntrinsicType' },
      { n: 'dotNetBF.Core.Scripting.IExpandoType' },
      { n: 'System.IComparable' },
      {
        n: 'System.IEquatable`1[[dotNetBF.Gui.GuiObject, bfsvclib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=null]]',
      },
      {
        n: 'dotNetBF.Core.Scripting.IntrinsicEvalContext,bfscripting',
        b: 11,
        i: [2, 3, 4, 5, 6, 7],
      },
      { n: 'dotNetBF.Core.Scripting.EvalContext,bfscripting', b: 12, i: [2, 3] },
      { n: 'System.Reflection.Binder,mscorlib' },
    ],
  };
  return {
    ContextOPath: main.__opath,
    WorkflowType: 'View',
    WorkflowName: 'ShowMyOPs',
    Model: {
      iseditable: false,
      formname: 'default',
      deserializeReadonlyModel: false,
      original: [main, { ...list, FilterJson: null }],
      modified: [main, { ...list, FilterJson: JSON.stringify(filter) }],
      types: [{ n: main.__type }, { n: list.__type }],
    },
  };
})();

export interface OtmaListTicket {
  key: string;
  url: string;
  title: string;
  /** Linked BSM ticket key, '' if none. */
  bsm: string;
  status: string;
  responsible: string;
  project: string;
  changedAt: string | null;
}

/**
 * The result list: rows [{op}, …cells] with one cell per visible (not hidden) column; texts as
 * 0-based indexes into `strings` (links as {v: index}), dates as 1-based indexes into `dates`. The
 * ticket number is the object id of `op` in hex ("2B89D@1000A5" → 178333).
 */
export function parseOtmaTicketList(json: unknown): OtmaListTicket[] {
  const parsed = viewSchema.safeParse(json);
  if (!parsed.success) throw new Error('OTMA: unerwartete Antwort (keine Ticketliste)');
  const list = nodes(parsed.data.ui.form).find((n) => n.feat === 'Items' && Array.isArray(n.data));
  if (!list) throw new Error('OTMA: unerwartete Antwort (keine Ticketliste)');
  const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []);
  const strings = arr(list.strings);
  const dates = arr(list.dates);
  const columns = arr(list.columns)
    .map((c) => c as Record<string, unknown>)
    .filter((c) => !c.hidden)
    .map((c) => str(c.name));
  const out: OtmaListTicket[] = [];
  for (const row of arr(list.data)) {
    if (!Array.isArray(row)) continue;
    const m = /^([0-9A-F]{1,12})@[0-9A-F]{1,12}$/i.exec(
      str((row[0] as Record<string, unknown> | undefined)?.op),
    );
    if (!m) continue;
    const cell = (column: string) => {
      const c = row[columns.indexOf(column) + 1] as unknown;
      return c && typeof c === 'object' ? (c as Record<string, unknown>).v : c;
    };
    const text = (column: string) => {
      const i = cell(column);
      return typeof i === 'number' ? str(strings[i]) : '';
    };
    const d = cell('ChangeDate');
    const ms = typeof d === 'number' ? dates[d - 1] : undefined;
    const key = String(parseInt(m[1]!, 16));
    out.push({
      key,
      url: `${OTMA_TICKET_BASE}${key}`,
      title: text('Name') || key,
      bsm: text('SupportIDLink'),
      status: text('Status'),
      responsible: text('cfResponsiblePersonDisplayText'),
      project: text('Project'),
      changedAt: typeof ms === 'number' ? new Date(ms).toISOString() : null,
    });
  }
  return out;
}

/** The user's own open OTMA tickets. */
export async function otmaMyTickets(session: BsmSession): Promise<OtmaListTicket[]> {
  return session(async (http) =>
    parseOtmaTicketList(await http.runWorkflow(OTMA_MY_TICKETS_REQUEST)),
  );
}
