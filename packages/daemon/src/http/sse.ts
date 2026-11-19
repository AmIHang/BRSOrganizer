import type { Core, CoreEventMap, Item } from '@brsorganizer/core';
import type { RequestHandler } from 'express';

const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events for the app: list refreshes and toasts.
 * Events: `items-changed`, `items-added` (full items, for notifications), `sync-finished`,
 * `notice` (a message for the user).
 */
export function sseHandler(core: Core, heartbeatMs = HEARTBEAT_MS): RequestHandler {
  return (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onChanged = (e: CoreEventMap['items-changed'][0]) => send('items-changed', e);
    const onAdded = (e: CoreEventMap['items-added-by-sync'][0]) => {
      const items: Item[] = [];
      for (const id of e.ids) {
        try {
          items.push(core.items.get(id));
        } catch {
          // gone in the meantime
        }
      }
      send('items-added', { source: e.source, items });
    };
    const onSync = (e: CoreEventMap['sync-finished'][0]) => send('sync-finished', e);
    const onNotice = (e: CoreEventMap['notice'][0]) => send('notice', e);

    core.events.on('items-changed', onChanged);
    core.events.on('items-added-by-sync', onAdded);
    core.events.on('sync-finished', onSync);
    core.events.on('notice', onNotice);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);

    req.on('close', () => {
      clearInterval(heartbeat);
      core.events.off('items-changed', onChanged);
      core.events.off('items-added-by-sync', onAdded);
      core.events.off('sync-finished', onSync);
      core.events.off('notice', onNotice);
    });
  };
}
