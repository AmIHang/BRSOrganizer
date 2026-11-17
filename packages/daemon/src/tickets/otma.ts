import { OTMA_TICKET_BASE, type Core } from '@brsorganizer/core';
import { z } from 'zod';
import {
  nodes,
  richText,
  saveTicket,
  str,
  title,
  parseDate,
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
    // shortcut: the "Dokumente" list is not read yet (no sample ticket with documents); the agent
    // gets the link. Add it like BSM's FilteredDocuments once a ticket with documents is at hand.
    attachments: [],
  };
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
  return /^[A-Za-z][A-Za-z0-9_]*\d+$/.test(v) ? v : null;
}

/**
 * New todos with an OTMA but no BSM ticket get the BSM ticket the OTMA ticket links to. Runs in
 * the background (reading OTMA may need the Edge login); a failure only leaves the field empty.
 */
export function fillBsmFromOtma(
  core: Core,
  session: BsmSession,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
): void {
  core.events.on('items-changed', ({ reason, actor, ids }) => {
    if (reason !== 'created' || actor === 'sync') return;
    for (const id of ids) {
      const item = core.items.get(id);
      const key = item.otmaUrl ? otmaKey(item.otmaUrl) : null;
      if (item.type !== 'todo' || item.bsmUrl || !key) continue;
      void session(async (http) => otmaBsmKey(await otmaView(http, key)))
        .then((bsm) => {
          const now = core.items.get(id);
          // Only if nobody set a BSM ticket or changed the OTMA ticket in the meantime.
          if (bsm && !now.bsmUrl && now.otmaUrl === item.otmaUrl) {
            core.items.setTickets(id, { bsmUrl: bsm }, actor);
          }
        })
        .catch((err: unknown) =>
          log('could not read the BSM ticket from OTMA', {
            id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
  });
}
