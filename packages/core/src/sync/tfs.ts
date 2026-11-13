import type { ExternalItem, SyncSource } from './engine.js';
import { runPowerShell } from './powershell.js';

/**
 * Pull requests from Azure DevOps Server (on-prem TFS) or Azure DevOps Services via REST.
 *
 * Two collection-level queries (no loop over projects): active PRs where I am a reviewer, and
 * active PRs I created. Authentication either with the Windows login (integrated auth through
 * PowerShell, no secret at all) or with a personal access token.
 *
 * Items use the same source id and external id scheme as the mail fallback
 * (`host/collection/project/repo/id`), so switching between the two never duplicates a PR.
 */

/** Fetches absolute URLs and returns the parsed JSON bodies in the same order. */
export type TfsTransport = (urls: string[]) => Promise<unknown[]>;

const API = 'api-version=5.0';

/** Windows integrated authentication (NTLM/Kerberos) via Invoke-WebRequest. */
export const windowsAuthTransport: TfsTransport = async (urls) => {
  const script = String.raw`
$urls = $env:AMINEEDED_TFS_URLS | ConvertFrom-Json
$out = New-Object System.Collections.Generic.List[string]
foreach ($u in $urls) {
  $r = Invoke-WebRequest -UseBasicParsing -UseDefaultCredentials -Uri $u -TimeoutSec 30 -Headers @{ Accept = 'application/json' }
  $out.Add([string]$r.Content)
}
ConvertTo-Json -InputObject @($out.ToArray()) -Compress
`;
  const stdout = await runPowerShell(
    script,
    { AMINEEDED_TFS_URLS: JSON.stringify(urls) },
    'Azure DevOps (Windows login)',
  );
  const bodies = ([] as string[]).concat(JSON.parse(stdout || '[]') as string | string[]);
  return bodies.map((b) => JSON.parse(b) as unknown);
};

/** Personal access token (Basic auth with empty user name). */
export function patTransport(pat: string, fetchImpl: typeof fetch = fetch): TfsTransport {
  const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  return async (urls) =>
    Promise.all(
      urls.map(async (url) => {
        const res = await fetchImpl(url, {
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Azure DevOps request failed: HTTP ${res.status}`);
        return (await res.json()) as unknown;
      }),
    );
}

/** A single write request (PATCH/PUT/POST) with a JSON body; returns the parsed response. */
export type TfsSender = (request: {
  method: 'PATCH' | 'PUT' | 'POST';
  url: string;
  body: unknown;
}) => Promise<unknown>;

/** Error from Azure DevOps with its own message (e.g. a policy blocking a merge). */
export class TfsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TfsRequestError';
  }
}

/** Windows integrated authentication for writes. */
export const windowsAuthSender: TfsSender = async ({ method, url, body }) => {
  const script = String.raw`
$bytes = [Text.Encoding]::UTF8.GetBytes($env:AMINEEDED_TFS_BODY)
try {
  $r = Invoke-WebRequest -UseBasicParsing -UseDefaultCredentials -Uri $env:AMINEEDED_TFS_URL -Method $env:AMINEEDED_TFS_METHOD -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
  [pscustomobject]@{ status = [int]$r.StatusCode; body = [string]$r.Content } | ConvertTo-Json -Compress
} catch {
  $status = 0
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  [pscustomobject]@{ status = $status; body = [string]$_.ErrorDetails.Message; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
  const stdout = await runPowerShell(
    script,
    {
      AMINEEDED_TFS_URL: url,
      AMINEEDED_TFS_METHOD: method,
      AMINEEDED_TFS_BODY: JSON.stringify(body),
    },
    'Azure DevOps (Windows login)',
  );
  const r = JSON.parse(stdout) as { status: number; body: string; error?: string };
  return parseTfsResponse(r.status, r.body, r.error);
};

export function patSender(pat: string, fetchImpl: typeof fetch = fetch): TfsSender {
  const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  return async ({ method, url, body }) => {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    return parseTfsResponse(res.status, await res.text());
  };
}

function parseTfsResponse(status: number, body: string, error?: string): unknown {
  let json: unknown = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // not JSON
  }
  if (status >= 200 && status < 300) return json;
  const message =
    (json as { message?: string } | null)?.message ?? error ?? `HTTP ${status || 'error'}`;
  throw new TfsRequestError(status, message);
}

/**
 * Splits a PR web URL (as stored in item.link) into the repository API base and id:
 * https://host/tfs/coll/Project/_git/Repo/pullrequest/42
 *   -> https://host/tfs/coll/Project/_apis/git/repositories/Repo/pullrequests/42
 */
export function pullRequestApiUrl(prWebUrl: string): {
  api: string;
  repoUrl: string;
  collectionUrl: string;
  project: string;
  repo: string;
  id: number;
} | null {
  const m = /^(https?:\/\/.+?)\/([^/]+)\/_git\/([^/?#]+)\/pullrequest\/(\d+)/i.exec(prWebUrl);
  if (!m) return null;
  const [, collectionUrl, project, repo, id] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    api: `${collectionUrl}/${project}/_apis/git/repositories/${repo}/pullrequests/${id}`,
    repoUrl: `${collectionUrl}/${project}/_git/${repo}`,
    collectionUrl,
    project: decodeURIComponent(project),
    repo: decodeURIComponent(repo),
    id: Number(id),
  };
}

export function normalizeCollectionUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('collection URL must be http(s)');
  }
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

interface Identity {
  id: string;
  displayName?: string;
  uniqueName?: string;
}

interface ApiPullRequest {
  pullRequestId: number;
  title: string;
  status: string;
  isDraft?: boolean;
  creationDate: string;
  createdBy?: Identity;
  targetRefName?: string;
  repository: { name: string; webUrl?: string; project: { name: string } };
  reviewers?: Array<Identity & { vote?: number; isContainer?: boolean }>;
}

interface ApiList<T> {
  count: number;
  value: T[];
}

const VOTES: Record<number, string> = {
  10: 'approved',
  5: 'approved-with-suggestions',
  0: 'no-vote',
  [-5]: 'waiting-for-author',
  [-10]: 'rejected',
};

export interface TfsSourceOptions {
  collectionUrl: string;
  includeAuthored: boolean;
  transport: TfsTransport;
  /** Distinguishes identities per auth method (Windows login vs. token). */
  cacheKey?: string;
}

/** Signed-in user per collection URL; sources are rebuilt for every sync, the identity is not. */
const identityCache = new Map<string, Identity>();

export class TfsSource implements SyncSource {
  readonly id = 'tfs' as const;

  constructor(private readonly options: TfsSourceOptions) {}

  async fetchSnapshot(): Promise<ExternalItem[]> {
    const base = normalizeCollectionUrl(this.options.collectionUrl);
    const me = await this.whoAmI(base);

    const query = (criteria: string) =>
      `${base}/_apis/git/pullrequests?searchCriteria.status=active&${criteria}&$top=500&${API}`;
    const urls = [query(`searchCriteria.reviewerId=${encodeURIComponent(me.id)}`)];
    if (this.options.includeAuthored) {
      urls.push(query(`searchCriteria.creatorId=${encodeURIComponent(me.id)}`));
    }
    const lists = (await this.options.transport(urls)) as Array<ApiList<ApiPullRequest>>;
    for (const list of lists) {
      if (!list || !Array.isArray(list.value)) throw new Error('unexpected Azure DevOps response');
      // A full page might hide more: refuse rather than close what we did not see.
      if (list.value.length >= 500)
        throw new Error('more than 500 pull requests; refusing a partial sync');
    }

    const host = new URL(base).host.toLowerCase();
    const collection = decodeURIComponent(base.split('/').pop() ?? '').toLowerCase();
    const byKey = new Map<string, ExternalItem>();
    for (const pr of lists.flatMap((l) => l.value)) {
      const project = pr.repository.project.name;
      const repo = pr.repository.name;
      const key = `${host}/${collection}/${project}/${repo}/${pr.pullRequestId}`.toLowerCase();
      if (byKey.has(key)) continue;

      const mine = pr.reviewers?.find((r) => r.id === me.id);
      const authored = pr.createdBy?.id === me.id;
      // On my own PR my reviewer entry is self-added bookkeeping, not a review request.
      const reasons: string[] = [];
      if (authored) reasons.push('authored');
      else if (mine) reasons.push((mine.vote ?? 0) === 0 ? 'review-requested' : 'reviewed');

      const webRepo =
        pr.repository.webUrl ??
        `${base}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
      byKey.set(key, {
        externalId: key,
        type: 'pr',
        title: pr.title,
        link: `${webRepo}/pullrequest/${pr.pullRequestId}`,
        meta: {
          repo,
          number: pr.pullRequestId,
          project,
          author: pr.createdBy?.displayName ?? null,
          draft: pr.isDraft === true,
          reasons,
          myVote: mine ? (VOTES[mine.vote ?? 0] ?? String(mine.vote)) : null,
          targetBranch: pr.targetRefName?.replace(/^refs\/heads\//, '') ?? null,
          prCreatedAt: pr.creationDate,
        },
      });
    }
    return [...byKey.values()];
  }

  private async whoAmI(base: string): Promise<Identity> {
    const cacheKey = `${this.options.cacheKey ?? 'default'}|${base}`;
    const cached = identityCache.get(cacheKey);
    if (cached) return cached;
    const [data] = (await this.options.transport([`${base}/_apis/connectionData`])) as Array<{
      authenticatedUser?: Identity;
    }>;
    const user = data?.authenticatedUser;
    if (!user?.id) throw new Error('Azure DevOps did not return the signed-in user');
    identityCache.set(cacheKey, user);
    return user;
  }
}
