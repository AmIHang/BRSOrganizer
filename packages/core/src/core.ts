import { systemClock, type Clock } from './clock.js';
import { openDatabase, type DatabaseHandle } from './db/client.js';
import { CoreEvents } from './events.js';
import { ItemService } from './items/service.js';
import { databaseFile } from './paths.js';
import { KeyringSecretStore } from './secrets/keyring.js';
import type { SecretStore } from './secrets/store.js';
import { SettingsService } from './settings.js';
import { SyncEngine, type SyncResult } from './sync/engine.js';
import type { GraphqlClient } from './sync/github.js';
import type { FetchText } from './sync/ics.js';
import { buildSources, type SourceStatus } from './sync/sources.js';

export interface CoreOptions {
  /** DB file or `:memory:`. Default: `%LOCALAPPDATA%\AmINeeded\amineeded.db`. */
  databaseFile?: string;
  migrationsFolder?: string;
  secrets?: SecretStore;
  clock?: Clock;
  graphqlFactory?: (token: string) => GraphqlClient;
  fetchText?: FetchText;
}

export interface Core {
  items: ItemService;
  settings: SettingsService;
  sync: SyncEngine;
  secrets: SecretStore;
  events: CoreEvents;
  clock: Clock;
  /** Runs all enabled and configured sources. */
  syncAll(): Promise<{ results: SyncResult[]; status: SourceStatus }>;
  sourceStatus(): SourceStatus;
  close(): void;
}

export function createCore(options: CoreOptions = {}): Core {
  const clock = options.clock ?? systemClock;
  const secrets = options.secrets ?? new KeyringSecretStore();
  const handle: DatabaseHandle = openDatabase({
    file: options.databaseFile ?? databaseFile(),
    ...(options.migrationsFolder && { migrationsFolder: options.migrationsFolder }),
  });
  const events = new CoreEvents();
  const settings = new SettingsService(handle.db, clock);
  const sync = new SyncEngine(handle.db, clock, events);

  const sources = () =>
    buildSources(settings.get(), {
      clock,
      secrets,
      ...(options.graphqlFactory && { graphqlFactory: options.graphqlFactory }),
      ...(options.fetchText && { fetchText: options.fetchText }),
    });

  return {
    items: new ItemService(handle.db, clock, events),
    settings,
    sync,
    secrets,
    events,
    clock,
    async syncAll() {
      const { sources: list, status } = sources();
      return { results: await sync.runAll(list), status };
    },
    sourceStatus: () => sources().status,
    close: () => handle.close(),
  };
}
