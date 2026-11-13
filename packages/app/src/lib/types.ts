// Shapes of the daemon's REST API. The app talks HTTP only and does not import @amineeded/core.

export type ItemType = 'todo' | 'pr' | 'event';
export type ItemStatus = 'open' | 'done' | 'archived';
/** `tfs`: Azure DevOps PRs (API or mail fallback); `mail` is legacy. */
export type ItemSource = 'manual' | 'github' | 'calendar' | 'tfs' | 'mail';
export type SyncSourceId = 'github' | 'calendar' | 'tfs' | 'mail';
export type Actor = 'user' | 'claude' | 'copilot' | 'other' | 'sync';

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
  meta: Record<string, unknown> | null;
  createdBy: Actor;
  updatedBy: Actor;
  statusChangedBy: Actor;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastSeenAt: string | null;
}

/** What the "new" dialog creates. */
export type NewItem =
  | { type: 'todo'; title: string; dueAt: string | null }
  | { type: 'event'; title: string; startsAt: string; endsAt: string };

export interface Settings {
  syncIntervalMinutes: number;
  daemonPort: number;
  github: { enabled: boolean; includeAuthored: boolean; includeAssigned: boolean };
  calendar: { enabled: boolean; provider: 'ics' | 'outlook'; lookAheadDays: number };
  tfs: { enabled: boolean; collectionUrl: string; includeAuthored: boolean };
  mail: { enabled: boolean; outlookFolder: string; lookBackDays: number };
}

export interface SourceStatus {
  github: 'ready' | 'disabled' | 'missing-token';
  calendar: 'ready' | 'disabled' | 'missing-url';
  tfs: 'ready' | 'disabled' | 'missing-url';
  mail: 'ready' | 'disabled' | 'standby';
}

export interface SyncRun {
  id: number;
  source: SyncSourceId;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  added: number;
  updated: number;
  closed: number;
  reopened: number;
  error: string | null;
}

export interface DaemonStatus {
  version: string;
  sources: SourceStatus;
  nextSyncAt: string | null;
  lastRuns: SyncRun[];
}

export interface SecretsStatus {
  githubToken: boolean;
  calendarIcsUrl: boolean;
  tfsToken: boolean;
}

export type StreamEvent =
  | { type: 'items-changed'; data: { reason: string; actor: Actor; ids: string[] } }
  | { type: 'items-added'; data: { source: SyncSourceId; items: Item[] } }
  | { type: 'sync-finished'; data: { source: string; ok: boolean; error: string | null } };
