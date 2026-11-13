import type { Clock } from '../clock.js';
import type { SecretStore } from '../secrets/store.js';
import type { Settings } from '../settings.js';
import type { SyncSource } from './engine.js';
import { createGraphqlClient, GithubSource, type GraphqlClient } from './github.js';
import { IcsCalendarSource, type FetchText } from './ics.js';
import { MailPrSource, type MailboxReader } from './mail-prs.js';
import { outlookCalendarReader, outlookComReader } from './outlook.js';
import { OutlookCalendarSource, type CalendarReader } from './outlook-calendar.js';
import { patTransport, TfsSource, windowsAuthTransport, type TfsTransport } from './tfs.js';

export interface SourceDeps {
  clock: Clock;
  secrets: SecretStore;
  graphqlFactory?: (token: string) => GraphqlClient;
  fetchText?: FetchText;
  mailboxReader?: MailboxReader;
  calendarReader?: CalendarReader;
  /** Test hook: transport for the TFS source (receives the PAT, if any). */
  tfsTransport?: (pat: string | null) => TfsTransport;
}

export interface SourceStatus {
  github: 'ready' | 'disabled' | 'missing-token';
  calendar: 'ready' | 'disabled' | 'missing-url';
  tfs: 'ready' | 'disabled' | 'missing-url';
  /** `standby`: enabled, but not used because the TFS API is configured. */
  mail: 'ready' | 'disabled' | 'standby';
}

/** Builds the sources that are enabled and configured. Re-run after settings/secrets change. */
export function buildSources(
  settings: Settings,
  deps: SourceDeps,
): { sources: SyncSource[]; status: SourceStatus } {
  const sources: SyncSource[] = [];
  const status: SourceStatus = {
    github: 'disabled',
    calendar: 'disabled',
    tfs: 'disabled',
    mail: 'disabled',
  };

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

  if (settings.calendar.enabled && settings.calendar.provider === 'outlook') {
    sources.push(
      new OutlookCalendarSource({
        reader: deps.calendarReader ?? outlookCalendarReader,
        lookAheadDays: settings.calendar.lookAheadDays,
        clock: deps.clock,
      }),
    );
    status.calendar = 'ready';
  } else if (settings.calendar.enabled) {
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

  // Azure DevOps PRs: the API when configured, otherwise the mail folder as fallback.
  // Both use the source id `tfs`, so at most one of them may run.
  const tfsConfigured = settings.tfs.enabled && settings.tfs.collectionUrl !== '';
  if (tfsConfigured) {
    const pat = deps.secrets.get('tfs-token');
    sources.push(
      new TfsSource({
        collectionUrl: settings.tfs.collectionUrl,
        includeAuthored: settings.tfs.includeAuthored,
        transport: deps.tfsTransport?.(pat) ?? (pat ? patTransport(pat) : windowsAuthTransport),
        cacheKey: pat ? 'pat' : 'windows',
      }),
    );
    status.tfs = 'ready';
    if (settings.mail.enabled) status.mail = 'standby';
  } else {
    if (settings.tfs.enabled) status.tfs = 'missing-url';
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
  }

  return { sources, status };
}
