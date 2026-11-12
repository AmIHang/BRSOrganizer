import type { Clock } from '../clock.js';
import type { SecretStore } from '../secrets/store.js';
import type { Settings } from '../settings.js';
import type { SyncSource } from './engine.js';
import { createGraphqlClient, GithubSource, type GraphqlClient } from './github.js';
import { IcsCalendarSource, type FetchText } from './ics.js';

export interface SourceDeps {
  clock: Clock;
  secrets: SecretStore;
  graphqlFactory?: (token: string) => GraphqlClient;
  fetchText?: FetchText;
}

export interface SourceStatus {
  github: 'ready' | 'disabled' | 'missing-token';
  calendar: 'ready' | 'disabled' | 'missing-url';
}

/** Builds the sources that are enabled and configured. Re-run after settings/secrets change. */
export function buildSources(
  settings: Settings,
  deps: SourceDeps,
): { sources: SyncSource[]; status: SourceStatus } {
  const sources: SyncSource[] = [];
  const status: SourceStatus = { github: 'disabled', calendar: 'disabled' };

  if (settings.github.enabled) {
    const token = deps.secrets.get('github-token');
    if (token) {
      sources.push(
        new GithubSource((deps.graphqlFactory ?? createGraphqlClient)(token), {
          includeAuthored: settings.github.includeAuthored,
          includeAssigned: settings.github.includeAssigned,
        }),
      );
      status.github = 'ready';
    } else {
      status.github = 'missing-token';
    }
  }

  if (settings.calendar.enabled) {
    if (deps.secrets.get('calendar-ics-url')) {
      sources.push(
        new IcsCalendarSource({
          getUrl: () => deps.secrets.get('calendar-ics-url'),
          lookAheadDays: settings.calendar.lookAheadDays,
          clock: deps.clock,
          ...(deps.fetchText && { fetchText: deps.fetchText }),
        }),
      );
      status.calendar = 'ready';
    } else {
      status.calendar = 'missing-url';
    }
  }

  return { sources, status };
}
