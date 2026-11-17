import { z } from 'zod';
import {
  ACTORS,
  ITEM_SOURCES,
  ITEM_STATUSES,
  ITEM_TYPES,
  type Actor,
  type ItemMeta,
  type ItemRow,
  type ItemSource,
  type ItemStatus,
  type ItemType,
} from '../db/schema.js';

/** Public item shape (JSON-friendly: dates as ISO strings). */
export interface Item {
  id: string;
  type: ItemType;
  title: string;
  notes: string | null;
  link: string | null;
  dueAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: ItemStatus;
  source: ItemSource;
  externalId: string | null;
  meta: ItemMeta | null;
  createdBy: Actor;
  updatedBy: Actor;
  statusChangedBy: Actor;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastSeenAt: string | null;
  /** User-entered ticket links; kept across syncs. */
  bsmUrl: string | null;
  otmaUrl: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    notes: row.notes,
    link: row.link,
    dueAt: iso(row.dueAt),
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    status: row.status,
    source: row.source,
    externalId: row.externalId,
    meta: row.meta ?? null,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    statusChangedBy: row.statusChangedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
    lastSeenAt: iso(row.lastSeenAt),
    bsmUrl: row.bsmUrl ?? null,
    otmaUrl: row.otmaUrl ?? null,
  };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Accepts a Date, an ISO date-time with offset/`Z`, or a plain `YYYY-MM-DD`.
 * A plain date means "by the end of that day" in local time.
 */
export const dateInput = z
  .union([z.date(), z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((v) => {
    if (v instanceof Date) return v;
    const m = DATE_ONLY.exec(v);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    return new Date(v);
  })
  .refine((d) => !Number.isNaN(d.getTime()), 'invalid date');

const title = z.string().trim().min(1, 'title must not be empty').max(500);
const notes = z.string().max(10_000);
const link = z.url({ protocol: /^https?$/, error: 'link must be an http(s) URL' }).max(2048);

/** BSM tickets live at <base><key>, e.g. https://bsm.boomsoftware.com/indication/BRS_PWg0127. */
export const BSM_TICKET_BASE = 'https://bsm.boomsoftware.com/indication/';
const BSM_KEY = /^[A-Za-z][A-Za-z0-9_]*\d+$/;

/** A BSM ticket: full URL, or just the key ("BRS_PWg0127"), which is expanded to the URL. */
export const bsmTicketInput = z
  .string()
  .trim()
  .transform((v) => (BSM_KEY.test(v) ? `${BSM_TICKET_BASE}${v}` : v))
  .pipe(link);

/** OTMA tickets live at <base><number>, e.g. https://otma.boomsoftware.com/ap/148082. */
export const OTMA_TICKET_BASE = 'https://otma.boomsoftware.com/ap/';

/** An OTMA ticket: full URL, or just the number ("148082"), which is expanded to the URL. */
export const otmaTicketInput = z
  .string()
  .trim()
  .transform((v) => (/^#?\d+$/.test(v) ? `${OTMA_TICKET_BASE}${v.replace(/^#/, '')}` : v))
  .pipe(link);

export const ticketsInput = z
  .object({
    bsmUrl: bsmTicketInput.nullable().optional(),
    otmaUrl: otmaTicketInput.nullable().optional(),
  })
  .refine((v) => v.bsmUrl !== undefined || v.otmaUrl !== undefined, 'nothing to update');
export type TicketsInput = z.input<typeof ticketsInput>;

export const addTodoInput = z.object({
  title,
  notes: notes.nullish(),
  link: link.nullish(),
  dueAt: dateInput.nullish(),
  bsmUrl: bsmTicketInput.nullish(),
  otmaUrl: otmaTicketInput.nullish(),
});
export type AddTodoInput = z.input<typeof addTodoInput>;

/** An instant: Date or ISO 8601 date-time with offset/`Z` (no date-only: events need a time). */
const instantInput = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .refine((d) => !Number.isNaN(d.getTime()), 'invalid date');

export const DEFAULT_EVENT_MINUTES = 30;

/** A manually entered appointment (not from a calendar sync). */
export const addEventInput = z
  .object({
    title,
    notes: notes.nullish(),
    link: link.nullish(),
    startsAt: instantInput,
    /** Default: start + 30 minutes. */
    endsAt: instantInput.nullish(),
  })
  .refine((v) => !v.endsAt || v.endsAt.getTime() >= v.startsAt.getTime(), {
    message: 'endsAt must not be before startsAt',
    path: ['endsAt'],
  });
export type AddEventInput = z.input<typeof addEventInput>;

export const updateTodoInput = z
  .object({
    title: title.optional(),
    notes: notes.nullable().optional(),
    link: link.nullable().optional(),
    dueAt: dateInput.nullable().optional(),
    /** Project (customer) the todo is filed under, like a PR's project; null removes it. */
    project: z.string().trim().min(1).max(100).nullable().optional(),
    /** Branch an agent works on for this todo; the sync turns the todo into its PR. */
    agentBranch: z.string().trim().min(1).max(200).nullable().optional(),
    /** Last answer of the agent's session (it waits for the user); null removes it. */
    agentReply: z.string().trim().min(1).max(20_000).nullable().optional(),
    /** What the agent's session waits for (e.g. a permission prompt); null when it works on. */
    agentWaiting: z.string().trim().min(1).max(200).nullable().optional(),
    /** The agent's session is gone (ended, crashed, stopped elsewhere) before a PR showed up. */
    agentEnded: z.boolean().nullable().optional(),
    /** Worktree the agent worked in; kept after the hand-off so it can be removed later. */
    agentWorktree: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');
export type UpdateTodoInput = z.input<typeof updateTodoInput>;

export const listFilterInput = z.object({
  type: z.enum(ITEM_TYPES).optional(),
  /** Default: `open`. `all` includes archived. */
  status: z
    .union([z.enum(ITEM_STATUSES), z.array(z.enum(ITEM_STATUSES)), z.literal('all')])
    .optional(),
  source: z.enum(ITEM_SOURCES).optional(),
  /** Items whose due date (todos/PRs) or start (events) is before this instant. */
  dueBefore: dateInput.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type ListFilter = z.input<typeof listFilterInput>;

export const actorInput = z.enum(ACTORS);
