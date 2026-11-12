import type { Clock } from '../clock.js';
import type { SecretStore } from '../secrets/store.js';
import type { Settings } from '../settings.js';
import type { SyncSource } from './engine.js';
import { createGraphqlClient, GithubSource, type GraphqlClient } from './github.js';
import { IcsCalendarSource, type FetchText } from './ics.js';
import { MailPrSource, type MailboxReader } from './mail-prs.js';
import { outlookComReader } from './outlook.js';

export interface SourceDeps {
  clock: Clock;
  secrets: SecretStore;
  graphqlFactory?: (token: string) => GraphqlClient;
  fetchText?: FetchText;
  mailboxReader?: MailboxReader;
}

export interface SourceStatus {
  github: 'ready' | 'disabled' | 'missing-token';
  calendar: 'ready' | 'disabled' | 'missing-url';
  mail: 'ready' | 'disabled';
}

/** Builds the sources that are enabled and configured. Re-run after settings/secrets change. */
export function buildSources(
  settings: Settings,
  deps: SourceDeps,
): { sources: SyncSource[]; status: SourceStatus } {
  const sources: SyncSource[] = [];
  const status: SourceStatus = { github: 'disabled', calendar: 'disabled', mail: 'disabled' };

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

  if (settings.mail.enabled) {
    sources.push(
      new MailPrSource({
        reader: deps.mailboxReader ?? outlookComReader,
        folderPath: settings.mail.outlookFolder,
        lookBackDays: settings.mail.lookBackDays,
        clock: deps.clock,
      }),
    );
    status.mail = 'ready';
  }

  return { sources, status };
}
