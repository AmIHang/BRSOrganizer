import { join } from 'node:path';
import {
  ForbiddenOperationError,
  NotFoundError,
  patSender,
  patTransport,
  pullRequestApiUrl,
  ValidationError,
  windowsAuthSender,
  windowsAuthTransport,
  type Core,
  type Item,
  type TfsSender,
  type TfsTransport,
} from '@amineeded/core';
import type { Launcher } from './launcher.js';
import {
  findRepo,
  localCheckout,
  scanRepos,
  type LocalCheckout,
  type RepoInfo,
} from './workspace.js';

const API = 'api-version=5.0';

const VOTES: Record<number, string> = {
  10: 'genehmigt',
  5: 'genehmigt mit Vorschlägen',
  0: 'keine Stimme',
  [-5]: 'wartet auf Autor',
  [-10]: 'abgelehnt',
};

interface ApiIdentity {
  id: string;
  displayName?: string;
}

interface ApiPr {
  pullRequestId: number;
  title: string;
  description?: string;
  status: 'active' | 'completed' | 'abandoned' | string;
  isDraft?: boolean;
  mergeStatus?: string;
  sourceRefName: string;
  targetRefName: string;
  createdBy?: ApiIdentity;
  creationDate?: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
  reviewers?: Array<ApiIdentity & { vote?: number; isContainer?: boolean; isRequired?: boolean }>;
}

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
    | ({ state: 'ok'; customer: string; repoName: string } & LocalCheckout);
}

export interface CompleteResult {
  status: string;
  mergeStatus: string | null;
  mergeCommit: string | null;
  approved: boolean;
}

export interface PrWorkspaceDeps {
  core: Core;
  launcher: Launcher;
  /** Folder with Clone-Branch.ps1, Remove-PrClone.ps1 and PrIis.ps1. */
  scriptsDir: string | null;
  /** Test hook; default: PAT from the Credential Manager, else the Windows login. */
  tfs?: (pat: string | null) => { transport: TfsTransport; sender: TfsSender };
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
}

const strip = (ref: string) => ref.replace(/^refs\/heads\//, '');

/**
 * PR-Manager features for TFS pull requests: details, local checkout, open, remove and
 * complete. Available through REST (the user) only, never through MCP.
 */
export class PrWorkspace {
  constructor(private readonly deps: PrWorkspaceDeps) {}

  private tfs() {
    const pat = this.deps.core.secrets.get('tfs-token');
    return (
      this.deps.tfs?.(pat) ?? {
        transport: pat ? patTransport(pat) : windowsAuthTransport,
        sender: pat ? patSender(pat) : windowsAuthSender,
      }
    );
  }

  private pullRequest(itemId: string) {
    const item: Item = this.deps.core.items.get(itemId);
    if (item.type !== 'pr' || !item.link) {
      throw new ForbiddenOperationError(`item ${itemId} is not a pull request with a link`);
    }
    const ref = pullRequestApiUrl(item.link);
    if (!ref)
      throw new ForbiddenOperationError('only Azure DevOps / TFS pull requests are supported');
    return { item, ref };
  }

  private async fetchPr(api: string): Promise<ApiPr> {
    const [pr] = (await this.tfs().transport([`${api}?${API}`])) as [ApiPr];
    return pr;
  }

  private async me(collectionUrl: string): Promise<ApiIdentity> {
    const [data] = (await this.tfs().transport([`${collectionUrl}/_apis/connectionData`])) as [
      { authenticatedUser?: ApiIdentity },
    ];
    if (!data?.authenticatedUser?.id)
      throw new Error('Azure DevOps did not return the signed-in user');
    return data.authenticatedUser;
  }

  private repoFor(repoUrl: string): { root: string; repo: RepoInfo | null } {
    const root = this.deps.core.settings.get().workspace.projectsRoot;
    return { root, repo: root ? findRepo(scanRepos(root), repoUrl) : null };
  }

  private requireLocal(itemId: string) {
    const { ref } = this.pullRequest(itemId);
    const { root, repo } = this.repoFor(ref.repoUrl);
    if (!root) throw new ValidationError('no projects folder configured (settings → PR workspace)');
    if (!repo) {
      throw new NotFoundError(`no repository for ${ref.project}/${ref.repo} found below ${root}`);
    }
    return { ref, root, repo };
  }

  private script(name: string): string {
    if (!this.deps.scriptsDir) throw new Error('PR scripts are not available in this installation');
    return join(this.deps.scriptsDir, name);
  }

  async details(itemId: string, options: { fetch?: boolean } = {}): Promise<PrDetails> {
    const { ref } = this.pullRequest(itemId);
    const [pr, me] = await Promise.all([
      this.fetchPr(ref.api),
      this.me(ref.collectionUrl).catch(() => null),
    ]);
    const sourceBranch = strip(pr.sourceRefName);

    const { root, repo } = this.repoFor(ref.repoUrl);
    let local: PrDetails['local'];
    if (!root) local = { state: 'not-configured' };
    else if (!repo) local = { state: 'no-repo', projectsRoot: root };
    else {
      local = {
        state: 'ok',
        customer: repo.customer,
        repoName: repo.repoName,
        ...(await localCheckout(repo, ref.id, {
          branch: sourceBranch,
          fetch: options.fetch ?? false,
        })),
      };
    }

    return {
      pr: {
        id: pr.pullRequestId,
        title: pr.title,
        status: pr.status,
        isDraft: pr.isDraft === true,
        mergeStatus: pr.mergeStatus ?? null,
        sourceBranch,
        targetBranch: strip(pr.targetRefName),
        author: pr.createdBy?.displayName ?? null,
        reviewers: (pr.reviewers ?? []).map((r) => ({
          name: r.displayName ?? r.id,
          vote: VOTES[r.vote ?? 0] ?? String(r.vote),
          isGroup: r.isContainer === true,
          isMe: me !== null && r.id === me.id,
        })),
        webUrl: `${ref.repoUrl}/pullrequest/${ref.id}`,
      },
      local,
    };
  }

  /** Clone (first time) or update and rebuild, in a visible console window. */
  cloneOrUpdate(itemId: string): { clonePath: string } {
    const { ref, root, repo } = this.requireLocal(itemId);
    const script = this.script('Clone-Branch.ps1');
    this.deps.launcher.runScript(`PR ${ref.id} – ${repo.customer}`, script, [
      '-Project',
      repo.customer,
      '-PrNumber',
      String(ref.id),
      '-Repo',
      repo.repoName,
      '-Root',
      root,
    ]);
    return { clonePath: join(repo.customerDir, `PR${ref.id}`) };
  }

  /** Deletes the checkout together with its IIS app pool (UAC), in a visible console window. */
  async removeLocal(itemId: string): Promise<{ clonePath: string }> {
    const { ref, repo } = this.requireLocal(itemId);
    const local = await localCheckout(repo, ref.id);
    if (local.cloned && !local.managed) {
      throw new ForbiddenOperationError(`${local.clonePath} was not created by the clone script`);
    }
    this.deps.launcher.runScript(`PR ${ref.id} löschen`, this.script('Remove-PrClone.ps1'), [
      '-Path',
      local.clonePath,
      '-Force',
    ]);
    return { clonePath: local.clonePath };
  }

  async open(itemId: string, target: 'solution' | 'folder'): Promise<void> {
    const { ref, repo } = this.requireLocal(itemId);
    const local = await localCheckout(repo, ref.id);
    if (!local.cloned) throw new NotFoundError(`PR ${ref.id} is not cloned yet`);
    const path = target === 'solution' ? local.solution : local.clonePath;
    if (!path) throw new NotFoundError(`no solution found in ${local.clonePath}`);
    this.deps.launcher.open(path);
  }

  /**
   * Squash-merges into the target branch and deletes the source branch, optionally voting
   * "approved" first. Waits up to about a minute for the merge.
   */
  async complete(itemId: string, options: { approve: boolean }): Promise<CompleteResult> {
    const { ref } = this.pullRequest(itemId);
    const { sender } = this.tfs();
    const pr = await this.fetchPr(ref.api);
    if (pr.status !== 'active')
      throw new ForbiddenOperationError(`PR ${ref.id} is already ${pr.status}`);
    if (!pr.lastMergeSourceCommit?.commitId) throw new Error('PR has no source commit to merge');

    let approved = false;
    if (options.approve) {
      const me = await this.me(ref.collectionUrl);
      await sender({
        method: 'PUT',
        url: `${ref.api}/reviewers/${me.id}?${API}`,
        body: { vote: 10 },
      });
      approved = true;
    }

    let message = `PR ${ref.id} (${pr.title}) gemergt`;
    if (pr.description) message += `\n\n${pr.description}`;
    await sender({
      method: 'PATCH',
      url: `${ref.api}?${API}`,
      body: {
        status: 'completed',
        lastMergeSourceCommit: { commitId: pr.lastMergeSourceCommit.commitId },
        completionOptions: {
          deleteSourceBranch: true,
          squashMerge: true,
          mergeStrategy: 'squash',
          mergeCommitMessage: message,
          transitionWorkItems: false,
        },
      },
    });

    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let latest = pr;
    for (let i = 0; i < (this.deps.pollAttempts ?? 20); i++) {
      await sleep(3000);
      latest = await this.fetchPr(ref.api);
      if (latest.status !== 'active') break;
    }
    return {
      status: latest.status,
      mergeStatus: latest.mergeStatus ?? null,
      mergeCommit: latest.lastMergeCommit?.commitId ?? null,
      approved,
    };
  }
}
