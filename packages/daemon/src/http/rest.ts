import {
  ITEM_SOURCES,
  ITEM_STATUSES,
  ITEM_TYPES,
  ValidationError,
  type Core,
  type ListFilter,
} from '@brsorganizer/core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { prRouter } from '../prs/routes.js';
import type { PrWorkspace } from '../prs/service.js';
import type { Scheduler } from '../scheduler.js';
import { sseHandler } from './sse.js';

export interface RestDeps {
  core: Core;
  scheduler: Scheduler;
  version: string;
  /** Graceful stop requested by the app (a hard kill would skip cleanup). */
  onShutdown?: () => void;
  prWorkspace?: PrWorkspace;
}

/** Secrets the UI may write (never read back). The local access token is not among them. */
const WRITABLE_SECRETS = {
  'github-token': z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^\S+$/, 'token must not contain whitespace'),
  'tfs-token': z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^\S+$/, 'token must not contain whitespace'),
  'calendar-ics-url': z
    .string()
    .trim()
    .max(4096)
    .regex(/^(https?|webcals?):\/\/\S+$/i, 'must be an http(s) or webcal URL'),
} as const;
type WritableSecret = keyof typeof WRITABLE_SECRETS;

const listQuery = z.object({
  type: z.enum(ITEM_TYPES).optional(),
  source: z.enum(ITEM_SOURCES).optional(),
  status: z
    .union([
      z.literal('all'),
      z
        .string()
        .transform((s) => s.split(',').map((x) => x.trim()))
        .pipe(z.array(z.enum(ITEM_STATUSES)).min(1)),
    ])
    .optional(),
  dueBefore: z.string().optional(),
  limit: z.coerce.number().int().optional(),
});

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError(z.prettifyError(r.error));
  return r.data;
}

function secretName(req: Request): WritableSecret {
  const name = String(req.params.name);
  if (!(name in WRITABLE_SECRETS)) throw new ValidationError(`unknown secret ${name}`);
  return name as WritableSecret;
}

const id = (req: Request) => String(req.params.id);

/** REST API for the app. Every mutation here is attributed to the actor `user`. */
export function restRouter({
  core,
  scheduler,
  version,
  onShutdown,
  prWorkspace,
}: RestDeps): Router {
  const r = Router();

  if (prWorkspace) r.use('/prs', prRouter(prWorkspace, scheduler));

  r.post('/shutdown', (_req, res) => {
    if (!onShutdown) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(202).json({ ok: true });
    res.on('finish', () => setImmediate(onShutdown));
  });

  r.get('/status', (_req, res) => {
    res.json({
      version,
      sources: core.sourceStatus(),
      nextSyncAt: scheduler.nextRunAt()?.toISOString() ?? null,
      lastRuns: core.sync.lastRuns(10),
    });
  });

  r.get('/items', (req, res) => {
    const q = parse(listQuery, req.query);
    const filter: ListFilter = {
      ...(q.type && { type: q.type }),
      ...(q.source && { source: q.source }),
      ...(q.status && { status: q.status }),
      ...(q.dueBefore && { dueBefore: q.dueBefore }),
      ...(q.limit && { limit: q.limit }),
    };
    res.json({ items: core.items.list(filter) });
  });

  r.get('/items/:id', (req, res) => {
    res.json(core.items.get(id(req)));
  });

  r.post('/todos', (req, res) => {
    res.status(201).json(core.items.addTodo(req.body ?? {}, 'user'));
  });

  r.post('/events', (req, res) => {
    res.status(201).json(core.items.addEvent(req.body ?? {}, 'user'));
  });

  r.patch('/todos/:id', (req, res) => {
    res.json(core.items.updateTodo(id(req), req.body ?? {}, 'user'));
  });

  r.patch('/items/:id/tickets', (req, res) => {
    res.json(core.items.setTickets(id(req), req.body ?? {}, 'user'));
  });

  r.post('/items/:id/complete', (req, res) => {
    res.json(core.items.completeTodo(id(req), 'user'));
  });

  r.post('/items/:id/archive', (req, res) => {
    res.json(core.items.archiveItem(id(req), 'user'));
  });

  r.post('/items/:id/reopen', (req, res) => {
    res.json(core.items.reopenItem(id(req), 'user'));
  });

  r.post('/sync', async (_req, res) => {
    res.json(await scheduler.runNow());
  });

  r.get('/sync/runs', (_req, res) => {
    res.json({ runs: core.sync.lastRuns(50) });
  });

  r.get('/settings', (_req, res) => {
    res.json(core.settings.get());
  });

  r.patch('/settings', (req, res) => {
    const updated = core.settings.update(req.body ?? {});
    scheduler.reschedule();
    res.json(updated);
  });

  r.get('/secrets', (_req, res) => {
    // Only whether a secret is set — values never leave the Credential Manager via HTTP.
    res.json({
      githubToken: core.secrets.get('github-token') !== null,
      calendarIcsUrl: core.secrets.get('calendar-ics-url') !== null,
      tfsToken: core.secrets.get('tfs-token') !== null,
    });
  });

  r.put('/secrets/:name', (req, res) => {
    const name = secretName(req);
    const value = parse(z.object({ value: WRITABLE_SECRETS[name] }), req.body).value;
    core.secrets.set(name, value);
    scheduler.reschedule({ runSoon: true });
    res.status(204).end();
  });

  r.delete('/secrets/:name', (req, res) => {
    core.secrets.delete(secretName(req));
    res.status(204).end();
  });

  r.get('/stream', sseHandler(core));

  return r;
}
