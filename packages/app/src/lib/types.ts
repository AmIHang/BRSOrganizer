// Shapes of the daemon's REST API. The app talks HTTP only and does not import @brsorganizer/core.

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
  bsmUrl: string | null;
  otmaUrl: string | null;
}

/** One entry of a row's "…" menu. */
export interface MenuEntry {
  label: string;
  onclick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

/** GET /api/prs/clone-sync – per PR item id. */
export interface CloneSync {
  cloned: boolean;
  /** Commits on the server not yet in the local clone. */
  behind: number | null;
  remoteGone: boolean;
}

/** What the "new" dialog creates. */
export type NewItem =
  | {
      type: 'todo';
      title: string;
      dueAt: string | null;
      bsmUrl: string | null;
      otmaUrl: string | null;
    }
  | { type: 'event'; title: string; startsAt: string; endsAt: string };

export interface Settings {
  syncIntervalMinutes: number;
  daemonPort: number;
  github: { enabled: boolean; includeAuthored: boolean; includeAssigned: boolean };
  calendar: { enabled: boolean; provider: 'ics' | 'outlook'; lookAheadDays: number };
  tfs: { enabled: boolean; collectionUrl: string; includeAuthored: boolean };
  workspace: { projectsRoot: string };
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
  /** BSM/OTMA account (same login for both); the password is never sent back. */
  ticketUser: string | null;
  ticketPassword: boolean;
}

/** GET /api/prs/:id – PR details from TFS plus the local checkout. */
export interface PrDetails {
  pr: {
    id: number;
    title: string;
    status: string;
    isDraft: boolean;
    mergeStatus: string | null;
    sourceBranch: string;
    targetBranch: string;
    author: string | null;
    reviewers: Array<{ name: string; vote: string; isGroup: boolean; isMe: boolean }>;
    webUrl: string;
  };
  local:
    | { state: 'not-configured' }
    | { state: 'no-repo'; projectsRoot: string }
    | {
        state: 'ok';
        customer: string;
        repoName: string;
        clonePath: string;
        cloned: boolean;
        managed: boolean;
        solution: string | null;
        webUrls: string[];
        head: { sha: string; subject: string; when: string } | null;
        behind: number | null;
        remoteGone: boolean;
      };
}

export interface CompleteResult {
  status: string;
  mergeStatus: string | null;
  mergeCommit: string | null;
  approved: boolean;
}

export type StreamEvent =
  | { type: 'items-changed'; data: { reason: string; actor: Actor; ids: string[] } }
  | { type: 'items-added'; data: { source: SyncSourceId; items: Item[] } }
  | { type: 'sync-finished'; data: { source: string; ok: boolean; error: string | null } };
