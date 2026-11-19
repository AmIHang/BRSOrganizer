import { EventEmitter } from 'node:events';
import type { Actor, ExternalSource } from './db/schema.js';
import type { SyncResult } from './sync/engine.js';

export interface ItemsChangedEvent {
  reason: 'created' | 'updated' | 'status' | 'sync';
  actor: Actor;
  ids: string[];
}

export interface CoreEventMap {
  'items-changed': [ItemsChangedEvent];
  /** IDs of items that a sync just inserted (used for "new review request" toasts). */
  'items-added-by-sync': [{ source: ExternalSource; ids: string[] }];
  'sync-finished': [SyncResult];
  /** A message for the user, shown by the app as a notification (e.g. what a cleanup did). */
  notice: [{ title: string; body: string }];
}

/** In-process change notifications, consumed by the daemon (SSE, toasts). */
export class CoreEvents extends EventEmitter<CoreEventMap> {}
