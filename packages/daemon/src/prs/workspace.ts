import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local PR checkouts as created by Clone-Branch.ps1:
 *
 *   <projectsRoot>\<customer>\<repo>\        the customer's main repo (any name)
 *   <projectsRoot>\<customer>\PR<nr>\        PR checkout, marked with .git\clone-branch
 *
 * The customer folder for a PR is found by matching the PR's repository URL against the
 * `origin` remotes of the repos in the customer folders, so folder names do not matter.
 */

export const CLONE_MARKER = 'clone-branch';

export interface RepoInfo {
  customer: string;
  customerDir: string;
  repoName: string;
  repoDir: string;
  remoteUrl: string;
}

/** Comparable form of a git remote: lowercase, decoded, no credentials, no trailing slash/.git. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  try {
    u = decodeURIComponent(u);
  } catch {
    // keep as is
  }
  return u
    .toLowerCase()
    .replace(/^(https?:\/\/)[^@/]+@/, '$1')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

function originUrl(repoDir: string): string | null {
  try {
    const config = readFileSync(join(repoDir, '.git', 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config)?.[1] ?? '';
    return /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Main repos (not PR clones) directly in the customer folders below `projectsRoot`. */
export function scanRepos(projectsRoot: string): RepoInfo[] {
  if (!projectsRoot || !isDir(projectsRoot)) return [];
  const out: RepoInfo[] = [];
  for (const customer of readdirSync(projectsRoot)) {
    if (customer.startsWith('_') || customer.startsWith('.')) continue;
    const customerDir = join(projectsRoot, customer);
    if (!isDir(customerDir)) continue;
    let children: string[] = [];
    try {
      children = readdirSync(customerDir);
    } catch {
      continue;
    }
    for (const repoName of children) {
      const repoDir = join(customerDir, repoName);
      // A real repo has a .git directory (worktrees have a .git file); PR clones carry the marker.
      if (!isDir(join(repoDir, '.git')) || existsSync(join(repoDir, '.git', CLONE_MARKER)))
        continue;
      const remoteUrl = originUrl(repoDir);
      if (remoteUrl) out.push({ customer, customerDir, repoName, repoDir, remoteUrl });
    }
  }
  return out;
}

export function findRepo(repos: RepoInfo[], prRepoUrl: string): RepoInfo | null {
  const wanted = normalizeRemote(prRepoUrl);
  const matches = repos.filter((r) => normalizeRemote(r.remoteUrl) === wanted);
  // Prefer <customer>\<customer> like Clone-Branch.ps1 does.
  return (
    matches.find((r) => r.repoName.toLowerCase() === r.customer.toLowerCase()) ?? matches[0] ?? null
  );
}

function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

export interface LocalCheckout {
  clonePath: string;
  cloned: boolean;
  /** Created by Clone-Branch.ps1 (only those may be removed). */
  managed: boolean;
  solution: string | null;
  webUrls: string[];
  head: { sha: string; subject: string; when: string } | null;
  /** Commits on the server not yet in the clone; null when unknown. */
  behind: number | null;
  /** The PR branch no longer exists on the server. */
  remoteGone: boolean;
}

export function clonePathFor(repo: RepoInfo, prId: number): string {
  return join(repo.customerDir, `PR${prId}`);
}

/** Solution copy "<customer> │ PR<nr>.sln" (U+2502), or the older "<customer>_PR<nr>.sln". */
function findSolution(clonePath: string, customer: string, prId: number): string | null {
  const names = [`${customer} │ PR${prId}.sln`, `${customer}_PR${prId}.sln`];
  return names.map((n) => join(clonePath, n)).find((p) => existsSync(p)) ?? null;
}

async function findWebUrls(clonePath: string, prId: number): Promise<string[]> {
  let files: string[] = [];
  try {
    files = (await git(clonePath, ['ls-files', '*.csproj'])).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  const urls: string[] = [];
  const re = new RegExp(`<IISUrl>(https?://[^<]*-PR${prId}/?)</IISUrl>`, 'i');
  for (const f of files) {
    try {
      const m = re.exec(readFileSync(join(clonePath, f), 'utf8'));
      if (m) urls.push(m[1]!);
    } catch {
      // unreadable project file
    }
  }
  return urls;
}

export interface CloneSync {
  cloned: boolean;
  /** Commits on the server the clone does not have yet; null when unknown. */
  behind: number | null;
  remoteGone: boolean;
}

/**
 * Light check for the list: is the PR cloned, and is the server ahead? Uses the branch the
 * clone has checked out (Clone-Branch.ps1 checks out the PR branch), so no TFS call is needed.
 */
export async function cloneSync(repo: RepoInfo, prId: number): Promise<CloneSync> {
  const clonePath = clonePathFor(repo, prId);
  if (!isDir(join(clonePath, '.git'))) return { cloned: false, behind: null, remoteGone: false };
  let branch: string;
  try {
    branch = await git(clonePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return { cloned: true, behind: null, remoteGone: false };
  }
  if (!branch || branch === 'HEAD') return { cloned: true, behind: null, remoteGone: false };
  try {
    await git(clonePath, ['fetch', '-q', 'origin', branch], 60_000);
  } catch {
    return { cloned: true, behind: null, remoteGone: true };
  }
  try {
    const behind = Number(await git(clonePath, ['rev-list', '--count', `HEAD..origin/${branch}`]));
    return { cloned: true, behind: Number.isFinite(behind) ? behind : null, remoteGone: false };
  } catch {
    return { cloned: true, behind: null, remoteGone: false };
  }
}

/** Local state of the PR checkout. `branch` + `fetch` also compares with the server (slower). */
export async function localCheckout(
  repo: RepoInfo,
  prId: number,
  options: { branch?: string | null; fetch?: boolean } = {},
): Promise<LocalCheckout> {
  const clonePath = clonePathFor(repo, prId);
  const cloned = isDir(join(clonePath, '.git'));
  const state: LocalCheckout = {
    clonePath,
    cloned,
    managed: cloned && existsSync(join(clonePath, '.git', CLONE_MARKER)),
    solution: null,
    webUrls: [],
    head: null,
    behind: null,
    remoteGone: false,
  };
  if (!cloned) return state;

  state.solution = findSolution(clonePath, repo.customer, prId);
  state.webUrls = await findWebUrls(clonePath, prId);
  try {
    const [sha, subject, when] = (
      await git(clonePath, ['log', '-1', '--format=%h%x09%s%x09%cr'])
    ).split('\t');
    state.head = { sha: sha ?? '', subject: subject ?? '', when: when ?? '' };
  } catch {
    // empty repo
  }

  if (options.fetch && options.branch) {
    try {
      await git(clonePath, ['fetch', '-q', 'origin', options.branch], 60_000);
      state.behind = Number(
        await git(clonePath, ['rev-list', '--count', `HEAD..origin/${options.branch}`]),
      );
    } catch {
      state.remoteGone = true;
    }
  }
  return state;
}
