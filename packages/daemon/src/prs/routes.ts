import { ValidationError } from '@amineeded/core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Scheduler } from '../scheduler.js';
import type { PrWorkspace } from './service.js';

const itemId = (req: Request) => String(req.params.id);

function body<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ValidationError(z.prettifyError(r.error));
  return r.data;
}

/**
 * PR workspace actions for the app (REST only). Starting scripts, merging and deleting are
 * deliberately not available to MCP clients.
 */
export function prRouter(workspace: PrWorkspace, scheduler: Scheduler): Router {
  const r = Router();

  r.get('/:id', async (req, res) => {
    res.json(await workspace.details(itemId(req), { fetch: req.query.fetch === '1' }));
  });

  r.post('/:id/clone', (req, res) => {
    res.status(202).json(workspace.cloneOrUpdate(itemId(req)));
  });

  r.post('/:id/remove-local', async (req, res) => {
    res.status(202).json(await workspace.removeLocal(itemId(req)));
  });

  r.post('/:id/open', async (req, res) => {
    const { target } = body(z.object({ target: z.enum(['solution', 'folder']) }), req.body);
    await workspace.open(itemId(req), target);
    res.status(204).end();
  });

  r.post('/:id/complete', async (req, res) => {
    const { approve } = body(z.object({ approve: z.boolean().default(false) }), req.body);
    const result = await workspace.complete(itemId(req), { approve });
    // Let the list drop the merged PR right away instead of at the next scheduled sync.
    if (result.status === 'completed') void scheduler.runNow().catch(() => undefined);
    res.json(result);
  });

  return r;
}
