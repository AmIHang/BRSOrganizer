import { CoreError, ITEM_STATUSES, ITEM_TYPES, type Actor, type Core } from '@brsorganizer/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Scheduler } from '../scheduler.js';
import { EXTERNAL_NOTICE, itemResult, itemsResult } from './format.js';

export interface McpDeps {
  core: Core;
  scheduler: Scheduler;
  version: string;
  /** Resolved per session from the client's `initialize` info. */
  actor: () => Actor;
}

const INSTRUCTIONS = `BRSOrganizer answers "where am I needed right now?" for the user: their own todos, open
GitHub pull requests (mostly review requests) and upcoming calendar events in one list.
Use list_items to see what is open, add_todo to capture new work. Items are never deleted:
complete todos with complete_todo, hide anything (also PRs and events) with archive_item.
${EXTERNAL_NOTICE}`;

const BSM_HELP =
  'BSM ticket: full URL or just the key, e.g. "BRS_PWg0127" ' +
  '(becomes https://bsm.boomsoftware.com/indication/BRS_PWg0127).';

const OTMA_HELP =
  'OTMA ticket: full URL or just the number, e.g. "148082" ' +
  '(becomes https://otma.boomsoftware.com/ap/148082).';

const DATE_HELP =
  'ISO 8601 date-time with offset (e.g. 2026-11-20T14:00:00+01:00) or a plain date ' +
  '(YYYY-MM-DD = end of that day, local time).';

/** Turns domain errors into tool errors the model can read and recover from. */
async function guard(fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CoreError) {
      return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}` }] };
    }
    throw e;
  }
}

/** One MCP server instance per session (the actor depends on the connected client). */
export function createMcpServer({ core, scheduler, version, actor }: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'brsorganizer', title: 'BRSOrganizer', version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_items',
    {
      title: 'List items',
      description:
        'Lists todos, pull requests and calendar events, soonest first (by due date or start). ' +
        'Defaults to open items.',
      inputSchema: {
        type: z.enum(ITEM_TYPES).optional().describe('Only this item type.'),
        status: z
          .enum([...ITEM_STATUSES, 'all'])
          .optional()
          .describe('Default "open". "all" includes done and archived items.'),
        due_before: z
          .string()
          .optional()
          .describe(`Only items due (or starting) before this instant. ${DATE_HELP}`),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ type, status, due_before, limit }) =>
      guard(() =>
        itemsResult(
          core.items.list({
            ...(type && { type }),
            ...(status && { status }),
            ...(due_before && { dueBefore: due_before }),
            limit: limit ?? 100,
          }),
        ),
      ),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get item',
      description: 'Returns one item by id.',
      inputSchema: { id: z.string().describe('Item id from list_items.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => guard(() => itemResult(core.items.get(id))),
  );

  server.registerTool(
    'add_todo',
    {
      title: 'Add todo',
      description: 'Creates a new open todo for the user.',
      inputSchema: {
        title: z.string().describe('Short, actionable title.'),
        due_at: z.string().optional().describe(`Deadline. ${DATE_HELP}`),
        link: z.string().optional().describe('Related http(s) URL (issue, PR, document).'),
        notes: z.string().optional().describe('Details or context.'),
        bsm_url: z.string().optional().describe(BSM_HELP),
        otma_url: z.string().optional().describe(OTMA_HELP),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ title, due_at, link, notes, bsm_url, otma_url }) =>
      guard(() =>
        itemResult(
          core.items.addTodo(
            {
              title,
              dueAt: due_at ?? null,
              link: link ?? null,
              notes: notes ?? null,
              bsmUrl: bsm_url ?? null,
              otmaUrl: otma_url ?? null,
            },
            actor(),
          ),
          'todo created',
        ),
      ),
  );

  server.registerTool(
    'set_tickets',
    {
      title: 'Set ticket links',
      description:
        'Sets or clears (null) the BSM and/or OTMA ticket of a todo or pull request. ' +
        'Omitted fields stay unchanged. Ticket links survive syncs.',
      inputSchema: {
        id: z.string().describe('Item id (todo or pull request) from list_items.'),
        bsm_url: z.string().nullable().optional().describe(BSM_HELP),
        otma_url: z.string().nullable().optional().describe(OTMA_HELP),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, bsm_url, otma_url }) =>
      guard(() =>
        itemResult(
          core.items.setTickets(
            id,
            {
              ...(bsm_url !== undefined && { bsmUrl: bsm_url }),
              ...(otma_url !== undefined && { otmaUrl: otma_url }),
            },
            actor(),
          ),
          'tickets updated',
        ),
      ),
  );

  server.registerTool(
    'update_todo',
    {
      title: 'Update todo',
      description:
        'Changes fields of a todo. Omitted fields stay unchanged; null clears due_at, link or notes. ' +
        'Only todos can be edited; pull requests and events come from their source.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        due_at: z.string().nullable().optional().describe(DATE_HELP),
        link: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        project: z
          .string()
          .nullable()
          .optional()
          .describe('Project (customer) to file the todo under, as on pull requests; null removes it.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id, title, due_at, link, notes, project }) =>
      guard(() =>
        itemResult(
          core.items.updateTodo(
            id,
            {
              ...(title !== undefined && { title }),
              ...(due_at !== undefined && { dueAt: due_at }),
              ...(link !== undefined && { link }),
              ...(notes !== undefined && { notes }),
              ...(project !== undefined && { project }),
            },
            actor(),
          ),
          'todo updated',
        ),
      ),
  );

  server.registerTool(
    'complete_todo',
    {
      title: 'Complete todo',
      description: 'Marks a todo as done. Use archive_item for pull requests and events.',
      inputSchema: { id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }) => guard(() => itemResult(core.items.completeTodo(id, actor()), 'todo completed')),
  );

  server.registerTool(
    'archive_item',
    {
      title: 'Archive item',
      description:
        'Hides an item (todo, pull request or event) from the open list. Nothing is deleted; ' +
        'archived items stay archived even if their source still reports them.',
      inputSchema: { id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }) => guard(() => itemResult(core.items.archiveItem(id, actor()), 'item archived')),
  );

  server.registerTool(
    'sync_sources',
    {
      title: 'Sync sources',
      description:
        'Fetches GitHub pull requests and calendar events now instead of waiting for the next ' +
        'scheduled sync. Returns counts per source.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    () =>
      guard(async () => {
        const { results, status } = await scheduler.runNow();
        const summary = {
          sources: status,
          results: results.map((r) => ({
            source: r.source,
            ok: r.ok,
            error: r.error,
            added: r.added,
            updated: r.updated,
            closed: r.closed,
            reopened: r.reopened,
          })),
        };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
      }),
  );

  return server;
}

/** Maps MCP clientInfo to the `created_by` value. */
export function actorFromClient(clientName: string | undefined, override?: string): Actor {
  const o = override?.trim().toLowerCase();
  if (o === 'claude' || o === 'copilot' || o === 'other') return o;
  const n = (clientName ?? '').toLowerCase();
  if (n.includes('claude')) return 'claude';
  if (n.includes('copilot') || n.includes('visual studio code') || n.includes('vscode')) {
    return 'copilot';
  }
  return 'other';
}
