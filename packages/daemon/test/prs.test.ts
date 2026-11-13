import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TfsSender, TfsTransport } from '@amineeded/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StaticSource } from '../../core/test/helpers.js';
import { scriptCommand, startArguments, type Launcher } from '../src/prs/launcher.js';
import { PrWorkspace, type PrDetails } from '../src/prs/service.js';
import { cloneSync, findRepo, normalizeRemote, scanRepos } from '../src/prs/workspace.js';
import { auth, raw, startHarness, type Harness } from './harness.js';

const COLLECTION = 'https://tfs.example.com/tfs/boom';
const REPO_URL = `${COLLECTION}/Produktion/_git/Community`;
const PR_LINK = `${REPO_URL}/pullrequest/4393`;
const API = `${COLLECTION}/Produktion/_apis/git/repositories/Community/pullrequests/4393`;
const ME = { id: 'me-id', displayName: 'Muster Max' };

function makeRepo(dir: string, remote: string, marker = false) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'config'),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  if (marker) writeFileSync(join(dir, '.git', 'clone-branch'), 'test');
}

describe('workspace scan', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'amineeded-ws-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds main repos per customer and ignores PR clones, worktrees and _folders', () => {
    makeRepo(join(root, 'Community', 'Community'), REPO_URL);
    makeRepo(join(root, 'Community', 'PR4000'), REPO_URL, true); // clone, not a main repo
    makeRepo(join(root, 'STB', 'dev'), `${COLLECTION}/STB/_git/STB`);
    makeRepo(join(root, '_refcache', 'x'), REPO_URL);
    mkdirSync(join(root, 'Empty'));

    const repos = scanRepos(root);
    expect(repos.map((r) => `${r.customer}/${r.repoName}`).sort()).toEqual([
      'Community/Community',
      'STB/dev',
    ]);
    // Matching is by remote, case- and encoding-insensitive; folder names do not matter.
    expect(findRepo(repos, `${COLLECTION}/STB/_git/stb`)?.repoName).toBe('dev');
    expect(findRepo(repos, 'https://other/x/_git/y')).toBeNull();
    expect(scanRepos(join(root, 'missing'))).toEqual([]);
  });

  it('normalizes remotes', () => {
    expect(normalizeRemote('https://user@TFS.example.com/tfs/boom/Pro%20jekt/_git/Repo.git/')).toBe(
      'https://tfs.example.com/tfs/boom/pro jekt/_git/repo',
    );
  });
});

describe('cloneSync with real git', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amineeded-git-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
      stdio: 'pipe',
    });

  it('counts commits on the server that the clone does not have, and notices a deleted branch', async () => {
    // "server": a bare repo with branch feature/x
    const server = join(dir, 'server.git');
    const work = join(dir, 'work');
    sh(dir, 'init', '-q', '--bare', server);
    sh(dir, 'clone', '-q', server, work);
    sh(work, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(work, 'a.txt'), '1');
    sh(work, 'add', '.');
    sh(work, 'commit', '-q', '-m', 'one');
    sh(work, 'push', '-q', 'origin', 'feature/x');

    // PR clone as Clone-Branch.ps1 would make it: <customer>\PR7 on the PR branch
    const customerDir = join(dir, 'Kunde');
    sh(dir, 'clone', '-q', '--branch', 'feature/x', server, join(customerDir, 'PR7'));
    const repo = {
      customer: 'Kunde',
      customerDir,
      repoName: 'Kunde',
      repoDir: '',
      remoteUrl: server,
    };

    expect(await cloneSync(repo, 7)).toEqual({ cloned: true, behind: 0, remoteGone: false });

    writeFileSync(join(work, 'b.txt'), '2');
    sh(work, 'add', '.');
    sh(work, 'commit', '-q', '-m', 'two');
    writeFileSync(join(work, 'c.txt'), '3');
    sh(work, 'add', '.');
    sh(work, 'commit', '-q', '-m', 'three');
    sh(work, 'push', '-q', 'origin', 'feature/x');
    expect(await cloneSync(repo, 7)).toEqual({ cloned: true, behind: 2, remoteGone: false });

    sh(work, 'push', '-q', 'origin', '--delete', 'feature/x');
    expect(await cloneSync(repo, 7)).toMatchObject({ cloned: true, remoteGone: true });

    expect(await cloneSync(repo, 8)).toEqual({ cloned: false, behind: null, remoteGone: false });
  });
});

describe('script launcher', () => {
  it('opens a new console via cmd start with the script base64-encoded', () => {
    const line = startArguments('PR 4393 – Community', 'C:\\x\\Clone-Branch.ps1', [
      '-Root',
      'C:\\a&b',
    ]);
    expect(line).toMatch(
      /^\/d \/c start "PR 4393 _ Community" powershell\.exe -NoProfile -ExecutionPolicy Bypass -NoExit -EncodedCommand [A-Za-z0-9+/=]+$/,
    );
    // Nothing from the paths reaches cmd.exe unencoded (no & or quotes to misinterpret).
    expect(line).not.toContain('a&b');
    const encoded = line.split(' ').at(-1)!;
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("-Root 'C:\\a&b'");
  });

  it('quotes arguments for PowerShell and keeps flags bare', () => {
    expect(
      scriptCommand("PR 1 – O'Brien", 'C:\\Program Files\\AmINeeded\\Clone-Branch.ps1', [
        '-Project',
        "O'Brien",
        '-Root',
        'C:\\projects git',
      ]),
    ).toContain(
      "& 'C:\\Program Files\\AmINeeded\\Clone-Branch.ps1' -Project 'O''Brien' -Root 'C:\\projects git'",
    );
  });
});

describe('PR workspace via REST', () => {
  let root: string;
  let h: Harness;
  let launched: Array<{
    kind: 'script' | 'open';
    title?: string;
    script?: string;
    args?: string[];
    path?: string;
  }>;
  let sent: Array<{ method: string; url: string; body: unknown }>;
  let prStatus: string;

  const pr = () => ({
    pullRequestId: 4393,
    title: 'feat: added community RMH',
    description: 'Details',
    status: prStatus,
    isDraft: false,
    mergeStatus: 'succeeded',
    sourceRefName: 'refs/heads/feature/rmh',
    targetRefName: 'refs/heads/main',
    createdBy: ME,
    lastMergeSourceCommit: { commitId: 'abc123' },
    lastMergeCommit: prStatus === 'completed' ? { commitId: 'deadbeef0000' } : undefined,
    reviewers: [
      { ...ME, vote: 0 },
      { id: 'g', displayName: '[Produktion]\\Reviewers', vote: 10, isContainer: true },
    ],
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'amineeded-ws-'));
    makeRepo(join(root, 'Community', 'Community'), REPO_URL);
    launched = [];
    sent = [];
    prStatus = 'active';

    const transport: TfsTransport = async (urls) =>
      urls.map((u) => (u.endsWith('/_apis/connectionData') ? { authenticatedUser: ME } : pr()));
    const sender: TfsSender = async (req) => {
      sent.push(req);
      if (req.method === 'PATCH') prStatus = 'completed';
      return {};
    };
    const launcher: Launcher = {
      runScript: (title, script, args) => launched.push({ kind: 'script', title, script, args }),
      open: (path) => launched.push({ kind: 'open', path }),
    };

    h = await startHarness({
      prWorkspace: (core) =>
        new PrWorkspace({
          core,
          launcher,
          scriptsDir: 'C:\\app\\runtime\\scripts\\pr',
          tfs: () => ({ transport, sender }),
          sleep: async () => undefined,
        }),
    });
    await h.core.sync.run(
      new StaticSource('tfs', [
        {
          externalId: 'tfs.example.com/boom/produktion/community/4393',
          type: 'pr',
          title: 'feat: added community RMH',
          link: PR_LINK,
        },
      ]),
    );
  });

  afterEach(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });

  const prId = () => h.core.items.list({ type: 'pr' })[0]!.id;
  const call = (method: string, path: string, body?: unknown) =>
    raw(h.port, { method, path: `/api/prs/${prId()}${path}`, headers: auth, body });

  it('reports that the projects folder is not configured', async () => {
    const r = await call('GET', '');
    expect(r.status).toBe(200);
    expect(r.json<PrDetails>().local).toEqual({ state: 'not-configured' });
    expect((await call('POST', '/clone')).status).toBe(400);
  });

  it('shows PR details and the local state', async () => {
    h.core.settings.update({ workspace: { projectsRoot: root } });
    const d = (await call('GET', '')).json<PrDetails>();
    expect(d.pr).toMatchObject({
      id: 4393,
      status: 'active',
      sourceBranch: 'feature/rmh',
      targetBranch: 'main',
      mergeStatus: 'succeeded',
      webUrl: PR_LINK,
    });
    expect(d.pr.reviewers).toEqual([
      { name: 'Muster Max', vote: 'keine Stimme', isGroup: false, isMe: true },
      { name: '[Produktion]\\Reviewers', vote: 'genehmigt', isGroup: true, isMe: false },
    ]);
    expect(d.local).toMatchObject({
      state: 'ok',
      customer: 'Community',
      repoName: 'Community',
      cloned: false,
      clonePath: join(root, 'Community', 'PR4393'),
    });

    // After cloning: solution copy and managed marker are found.
    makeRepo(join(root, 'Community', 'PR4393'), REPO_URL, true);
    writeFileSync(join(root, 'Community', 'PR4393', 'Community \u2502 PR4393.sln'), '');
    const after = (await call('GET', '')).json<PrDetails>();
    expect(after.local).toMatchObject({
      cloned: true,
      managed: true,
      solution: join(root, 'Community', 'PR4393', 'Community \u2502 PR4393.sln'),
    });
  });

  it('starts the clone script with the customer, repo and projects folder', async () => {
    h.core.settings.update({ workspace: { projectsRoot: root } });
    expect((await call('POST', '/clone')).status).toBe(202);
    expect(launched).toEqual([
      {
        kind: 'script',
        title: 'PR 4393 – Community',
        script: join('C:\\app\\runtime\\scripts\\pr', 'Clone-Branch.ps1'),
        args: ['-Project', 'Community', '-PrNumber', '4393', '-Repo', 'Community', '-Root', root],
      },
    ]);
  });

  it('opens the solution and removes only clones made by the script', async () => {
    h.core.settings.update({ workspace: { projectsRoot: root } });
    expect((await call('POST', '/open', { target: 'solution' })).status).toBe(404); // not cloned

    makeRepo(join(root, 'Community', 'PR4393'), REPO_URL, false); // foreign folder, no marker
    expect((await call('POST', '/remove-local')).status).toBe(409);

    writeFileSync(join(root, 'Community', 'PR4393', '.git', 'clone-branch'), 'x');
    writeFileSync(join(root, 'Community', 'PR4393', 'Community_PR4393.sln'), '');
    expect((await call('POST', '/open', { target: 'solution' })).status).toBe(204);
    expect((await call('POST', '/open', { target: 'folder' })).status).toBe(204);
    expect((await call('POST', '/remove-local')).status).toBe(202);
    expect(launched.map((l) => l.path ?? l.args)).toEqual([
      join(root, 'Community', 'PR4393', 'Community_PR4393.sln'),
      join(root, 'Community', 'PR4393'),
      ['-Path', join(root, 'Community', 'PR4393'), '-Force'],
    ]);
  });

  it('completes the PR with squash merge, optionally approving first', async () => {
    const r = await call('POST', '/complete', { approve: true });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({
      status: 'completed',
      mergeStatus: 'succeeded',
      mergeCommit: 'deadbeef0000',
      approved: true,
    });
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ['PUT', `${API}/reviewers/me-id?api-version=5.0`],
      ['PATCH', `${API}?api-version=5.0`],
    ]);
    expect(sent[0]!.body).toEqual({ vote: 10 });
    expect(sent[1]!.body).toMatchObject({
      status: 'completed',
      lastMergeSourceCommit: { commitId: 'abc123' },
      completionOptions: { squashMerge: true, deleteSourceBranch: true, mergeStrategy: 'squash' },
    });

    // Already completed: refused.
    expect((await call('POST', '/complete', {})).status).toBe(409);
  });

  it('reports the clone state of all PRs for the list', async () => {
    const list = () =>
      raw(h.port, { path: '/api/prs/clone-sync', headers: auth }).then((r) =>
        r.json<Record<string, { cloned: boolean; behind: number | null }>>(),
      );
    expect(await list()).toEqual({}); // no projects folder yet

    h.core.settings.update({ workspace: { projectsRoot: root } });
    expect(await list()).toEqual({}); // cached for a minute: still the old answer

    // Writes invalidate the cache; a fake clone without a real git branch counts as cloned.
    await raw(h.port, {
      method: 'POST',
      path: `/api/prs/${prId()}/open`,
      headers: auth,
      body: { target: 'folder' },
    });
    makeRepo(join(root, 'Community', 'PR4393'), REPO_URL, true);
    const r = await raw(h.port, { path: '/api/prs/clone-sync?refresh=1', headers: auth });
    expect(r.json()).toEqual({ [prId()]: { cloned: true, behind: null, remoteGone: false } });
  });

  it('rejects non-PR items', async () => {
    const todo = h.core.items.addTodo({ title: 'x' }, 'user');
    const r = await raw(h.port, { path: `/api/prs/${todo.id}`, headers: auth });
    expect(r.status).toBe(409);
  });
});
