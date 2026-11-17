import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TfsSender, TfsTransport } from '@brsorganizer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCore, StaticSource } from '../../core/test/helpers.js';
import { BsmLoginRequiredError, type BsmHttp } from '../src/tickets/bsm.js';
import {
  hiddenCommand,
  scriptCommand,
  startArguments,
  type Launcher,
} from '../src/prs/launcher.js';
import { agentPrompt, PrWorkspace, type PrDetails } from '../src/prs/service.js';
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
    root = mkdtempSync(join(tmpdir(), 'brsorganizer-ws-'));
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
    dir = mkdtempSync(join(tmpdir(), 'brsorganizer-git-'));
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
      scriptCommand("PR 1 – O'Brien", 'C:\\Program Files\\BRSOrganizer\\Clone-Branch.ps1', [
        '-Project',
        "O'Brien",
        '-Root',
        'C:\\projects git',
      ]),
    ).toContain(
      "& 'C:\\Program Files\\BRSOrganizer\\Clone-Branch.ps1' -Project 'O''Brien' -Root 'C:\\projects git'",
    );
  });

  it("reports a hidden script run's error as one line with exit code 1", () => {
    expect(hiddenCommand('C:\\x\\Start-TodoAgent.ps1', ['-Name', "O'Brien"])).toContain(
      "try { & 'C:\\x\\Start-TodoAgent.ps1' -Name 'O''Brien' } " +
        "catch { Write-Output ('FEHLER: ' + $_.Exception.Message); exit 1 }",
    );
  });
});

describe('agent prompt', () => {
  it('names the PR <typ>(<BSM key or OTMA number>): <english description>', () => {
    const core = makeCore();
    const title = (input: { bsmUrl?: string; otmaUrl?: string }) =>
      agentPrompt(core.items.addTodo({ title: 'T', notes: 'n', ...input }, 'user'), 'P')
        .split('\n')
        .find((l) => l.includes('Titel des Pull Requests'));
    expect(title({ bsmUrl: 'STBBRSg0030', otmaUrl: '178317' })).toContain(
      '`<typ>(STBBRSg0030): <kurze Beschreibung auf Englisch>`',
    );
    expect(title({ otmaUrl: '178317' })).toContain(
      '`<typ>(178317): <kurze Beschreibung auf Englisch>`',
    );
    expect(title({})).toContain('`<typ>: <kurze Beschreibung auf Englisch>`');
    expect(title({})).toContain('feat, fix oder chore');
    expect(title({})).toContain('nicht aus dem Titel oder der Beschreibung des Auftrags');
  });

  it('asks only for an analysis when the developer gave no description', () => {
    const core = makeCore();
    const analysis = agentPrompt(
      core.items.addTodo({ title: 'X', otmaUrl: '178317' }, 'user'),
      'P',
    );
    expect(analysis).toContain('## Vorgehen: nur Analyse');
    expect(analysis).toContain('erstelle keinen Pull Request');
    expect(analysis).not.toContain('Erstelle einen Pull Request');

    const todo = core.items.addTodo({ title: 'T', notes: 'tu es' }, 'user');
    const impl = agentPrompt(todo, 'P');
    expect(impl).not.toContain('nur Analyse');
    // The agent names its branch itself but keeps the suffix the sync finds the PR by.
    expect(impl).toContain(
      `git branch -m feature/<kurzer-englischer-name>-${todo.id.slice(-6).toLowerCase()}`,
    );
  });

  it('names the desktop chat (PR<n>) #<BSM key or OTMA number> - <description>', () => {
    const core = makeCore();
    const chat = (input: { bsmUrl?: string; otmaUrl?: string }) =>
      agentPrompt(core.items.addTodo({ title: 'T', notes: 'n', ...input }, 'user'), 'P')
        .split('\n')
        .find((l) => l.includes('Claude-Desktop-App'));
    expect(chat({ bsmUrl: 'STBBRSg0030', otmaUrl: '178317' })).toContain(
      '`(PR<Nummer>) #STBBRSg0030 - <kurze Beschreibung>`',
    );
    expect(chat({ otmaUrl: '178317' })).toContain('`(PR<Nummer>) #178317 - <kurze Beschreibung>`');
    expect(chat({})).toContain('`(PR<Nummer>) - <kurze Beschreibung>`');
  });
});

describe('PR workspace via REST', () => {
  let root: string;
  let h: Harness;
  let bsmHttp: BsmHttp;
  let otmaHttp: BsmHttp;
  let launched: Array<{
    kind: 'script' | 'open';
    title?: string;
    script?: string;
    args?: string[];
    path?: string;
    env?: Record<string, string>;
  }>;
  let sent: Array<{ method: string; url: string; body: unknown }>;
  let hidden: { code: number; stdout: string; stderr: string };
  let stopped: string[];
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
    root = mkdtempSync(join(tmpdir(), 'brsorganizer-ws-'));
    makeRepo(join(root, 'Community', 'Community'), REPO_URL);
    launched = [];
    sent = [];
    hidden = { code: 0, stdout: 'backgrounded · 1a2b3c4d\nAGENT-MODE: background\n', stderr: '' };
    prStatus = 'active';
    stopped = [];
    bsmHttp = {
      runWorkflow: async () => {
        throw new BsmLoginRequiredError();
      },
      download: async () => new Uint8Array(),
    };
    otmaHttp = {
      runWorkflow: async () => {
        throw new BsmLoginRequiredError('OTMA');
      },
      download: async () => new Uint8Array(),
    };

    const transport: TfsTransport = async (urls) =>
      urls.map((u) => (u.endsWith('/_apis/connectionData') ? { authenticatedUser: ME } : pr()));
    const sender: TfsSender = async (req) => {
      sent.push(req);
      if (req.method === 'PATCH') prStatus = 'completed';
      return {};
    };
    const launcher: Launcher = {
      runScript: (title, script, args, env) =>
        launched.push({ kind: 'script', title, script, args, ...(env && { env }) }),
      runHidden: async (script, args, env) => {
        launched.push({ kind: 'script', script, args, ...(env && { env }) });
        return hidden;
      },
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
          bsm: (fn) => fn(bsmHttp),
          otma: (fn) => fn(otmaHttp),
          stopAgent: async (name) => {
            stopped.push(name);
          },
          closeIde: async (clonePath, id) => {
            launched.push({ kind: 'open', path: `closeIde:${clonePath}:${id}` });
            return { closed: 1, forced: 0 };
          },
        }),
    });
    await h.core.sync.run(
      new StaticSource('tfs', [
        {
          externalId: 'tfs.example.com/boom/produktion/community/4393',
          type: 'pr',
          title: 'feat: added community RMH',
          link: PR_LINK,
          meta: { project: 'Produktion' },
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

  it('hands a todo in a project to an agent in a new worktree of the project repo', async () => {
    h.core.settings.update({ workspace: { projectsRoot: root } });
    const todo = h.core.items.addTodo(
      {
        title: 'Ladung übernehmen!',
        notes: 'siehe Ticket',
        bsmUrl: 'BRS_PWg0127',
        otmaUrl: '148082',
      },
      'user',
    );
    const handOff = () =>
      raw(h.port, { method: 'POST', path: `/api/prs/todos/${todo.id}/agent`, headers: auth });
    expect((await handOff()).status).toBe(409); // not in a project yet

    h.core.items.updateTodo(todo.id, { project: 'Produktion' }, 'user');
    const r = await handOff();
    expect(r.status).toBe(202);
    const suffix = todo.id.slice(-6).toLowerCase();
    // Not logged in: the hand-off still happens, with the links only.
    expect(r.json()).toEqual({
      worktree: join(root, 'Community', `Todo-${suffix}`),
      branch: `feature/todo-${suffix}`,
      tickets: [
        { kind: 'bsm', ok: false, message: 'BSM: nicht angemeldet' },
        { kind: 'otma', ok: false, message: 'OTMA: nicht angemeldet' },
      ],
      mode: 'background',
      session: `Todo-${suffix}`,
    });
    const [run] = launched;
    expect(run!.script).toBe(join('C:\\app\\runtime\\scripts\\pr', 'Start-TodoAgent.ps1'));
    const args = run!.args!;
    expect(args.slice(0, 10)).toEqual([
      '-Root',
      root,
      '-Project',
      'Community',
      '-Repo',
      'Community',
      '-Name',
      `Todo-${suffix}`,
      '-Branch',
      `feature/todo-${suffix}`,
    ]);
    const prompt = readFileSync(args[11]!, 'utf8');
    rmSync(dirname(args[11]!), { recursive: true });
    expect(prompt).toContain('siehe Ticket');
    expect(prompt).toContain('https://bsm.boomsoftware.com/indication/BRS_PWg0127');
    expect(prompt).toContain('fix(BRS_PWg0127)');
    // PR title: the BSM key wins over the OTMA number.
    expect(prompt).toContain(
      'Titel des Pull Requests: `<typ>(BRS_PWg0127): <kurze Beschreibung auf Englisch>`',
    );
    expect(prompt).toContain('148082');
    expect(prompt).toContain('Der Inhalt wurde nicht vorab gelesen (BSM: nicht angemeldet)');
    expect(prompt).toContain('Der Inhalt wurde nicht vorab gelesen (OTMA: nicht angemeldet)');
    expect(prompt).not.toContain('<<<BSM-TICKET');
    // All sources, in order of precedence: own description, OTMA (internal), BSM (customer).
    const order = [
      '### 1. Beschreibung des Entwicklers\n\nsiehe Ticket',
      '### 2. OTMA-Ticket (intern)\n\nLink: https://otma.boomsoftware.com/ap/148082',
      '### 3. BSM-Ticket (Kunde)\n\nLink: https://bsm.boomsoftware.com/indication/BRS_PWg0127',
      '## Vorgehen',
    ].map((s) => prompt.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(prompt).toContain('Widersprechen sie sich, gilt die höher priorisierte');
    expect(prompt).not.toContain('BRS_TICKET_PASSWORD');
    expect(run!.env).toBeUndefined();
    expect(h.core.items.get(todo.id).meta).toMatchObject({
      agentBranch: `feature/todo-${suffix}`,
    });

    // With a BSM/OTMA account: credentials only through the environment, never in the prompt.
    h.core.secrets.set('ticket-user', 'max');
    h.core.secrets.set('ticket-password', 'geheim!');
    await handOff();
    const second = launched[1]!;
    expect(second.env).toEqual({ BRS_TICKET_USER: 'max', BRS_TICKET_PASSWORD: 'geheim!' });
    expect(second.args!.join(' ')).not.toContain('geheim!');
    const prompt2 = readFileSync(second.args![11]!, 'utf8');
    rmSync(dirname(second.args![11]!), { recursive: true });
    expect(prompt2).toContain('BRS_TICKET_PASSWORD');
    expect(prompt2).not.toContain('geheim!');
  });

  it('shows and clears the BORA module cache, and nothing else', async () => {
    const get = () => raw(h.port, { method: 'GET', path: '/api/prs/module-cache', headers: auth });
    const clear = () =>
      raw(h.port, { method: 'POST', path: '/api/prs/module-cache/clear', headers: auth });
    expect((await get()).status).toBe(400); // no projects folder yet

    h.core.settings.update({ workspace: { projectsRoot: root } });
    const cache = join(root, '_refcache');
    mkdirSync(join(cache, 'BM.Core', '1.9.0'), { recursive: true });
    mkdirSync(join(cache, '_patched', 'Community', 'MaintenanceNG', '4.23.0.14-ABC'), {
      recursive: true,
    });
    writeFileSync(join(cache, 'BM.Core', '1.9.0', 'a.dll'), Buffer.alloc(1000));
    writeFileSync(join(cache, '_patched', 'Community', 'MaintenanceNG', '4.23.0.14-ABC', 'b'), 'x');
    expect((await get()).json()).toEqual({ path: cache, exists: true, bytes: 1001 });

    expect((await clear()).json()).toEqual({ path: cache });
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(join(root, 'Community', 'Community'))).toBe(true); // repos untouched
    expect((await get()).json()).toEqual({ path: cache, exists: false, bytes: 0 });
    expect((await clear()).status).toBe(200); // already gone: fine
  });

  it('hands off a todo without note or ticket, and cancels the hand-off', async () => {
    h.core.settings.update({ workspace: { projectsRoot: root } });
    const todo = h.core.items.addTodo({ title: 'Nur ein Titel' }, 'user');
    h.core.items.updateTodo(todo.id, { project: 'Produktion' }, 'user');
    const post = (path: string) => raw(h.port, { method: 'POST', path, headers: auth });
    const cancel = () => post(`/api/prs/todos/${todo.id}/agent/cancel`);
    try {
      expect((await cancel()).status).toBe(409); // not handed off yet
      expect((await post(`/api/prs/todos/${todo.id}/agent`)).status).toBe(202);
      expect(readFileSync(launched[0]!.args![11]!, 'utf8')).toContain('## Vorgehen: nur Analyse');

      h.core.items.updateTodo(todo.id, { agentWaiting: 'permission prompt' }, 'claude');
      expect((await cancel()).status).toBe(200);
      expect(stopped).toEqual([`Todo-${todo.id.slice(-6).toLowerCase()}`]);
      const after = h.core.items.get(todo.id);
      expect(after.status).toBe('open');
      expect(after.meta).toEqual({ project: 'Produktion' });
    } finally {
      for (const l of launched) rmSync(dirname(l.args![11]!), { recursive: true, force: true });
    }
  });

  it('reports a failed agent start and falls back to a window', async () => {
    h.core.settings.update({ workspace: { projectsRoot: root } });
    const todo = h.core.items.addTodo({ title: 'X', notes: 'tu was' }, 'user');
    h.core.items.updateTodo(todo.id, { project: 'Produktion' }, 'user');
    const handOff = () =>
      raw(h.port, { method: 'POST', path: `/api/prs/todos/${todo.id}/agent`, headers: auth });
    try {
      hidden = {
        code: 1,
        stdout: 'Repo:     C:\\x\r\nFEHLER: git fetch fehlgeschlagen\r\n',
        stderr: '#< CLIXML\r\n<Objs Version="1.1.0.1"></Objs>',
      };
      const failed = await handOff();
      expect(failed.status).toBe(502);
      expect(failed.json()).toMatchObject({
        message: 'Agent-Start fehlgeschlagen: git fetch fehlgeschlagen',
      });

      hidden = {
        code: 0,
        stdout: 'claude --bg: Workspace not trusted.\nAGENT-MODE: window\n',
        stderr: '',
      };
      expect((await handOff()).json()).toMatchObject({ mode: 'window' });
    } finally {
      for (const l of launched) rmSync(dirname(l.args![11]!), { recursive: true, force: true });
    }
  });

  it('puts the BSM ticket contents and images into the agent task', async () => {
    h.core.settings.update({ workspace: { projectsRoot: root } });
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'bsm-indication.json'), 'utf8'),
    ) as unknown;
    bsmHttp = { runWorkflow: async () => fixture, download: async () => new Uint8Array([1]) };
    const todo = h.core.items.addTodo(
      { title: 'Termine zusammenlegen', bsmUrl: 'BRS_PWg0155' },
      'user',
    );
    h.core.items.updateTodo(todo.id, { project: 'Produktion' }, 'user');
    const r = await raw(h.port, {
      method: 'POST',
      path: `/api/prs/todos/${todo.id}/agent`,
      headers: auth,
    });
    expect(r.status).toBe(202);
    expect(r.json<{ tickets: unknown }>().tickets).toEqual([{ kind: 'bsm', ok: true }]);

    const promptFile = launched[0]!.args![11]!;
    const dir = dirname(promptFile);
    try {
      const prompt = readFileSync(promptFile, 'utf8');
      expect(prompt.charCodeAt(0)).toBe(0xfeff);
      expect(prompt).toContain('### 3. BSM-Ticket (Kunde)');
      expect(prompt).toContain('### 1. Beschreibung des Entwicklers\n\n(keine)');
      expect(prompt).not.toContain('OTMA-Ticket (intern)'); // no OTMA ticket on this todo
      expect(prompt).toContain('<<<BSM-TICKET\n### BSM-Ticket BRS_PWg0155: IH-Berechnung');
      expect(prompt).toContain('Gilt die Entscheidung aus 2024 noch?');
      expect(prompt).toContain(`- Bild 1 (image.png): ${join(dir, 'bsm-1-image.png')}`);
      expect(prompt).toContain('Ruf das Ticket nicht erneut ab.');
      expect(readFileSync(join(dir, 'bsm-2-vergleich.png'))).toEqual(Buffer.from([1]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      // Visual Studio with the PR solution is closed before the checkout gets deleted.
      `closeIde:${join(root, 'Community', 'PR4393')}:4393`,
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
