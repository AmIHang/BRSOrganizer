import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeCore, StaticSource } from '../../core/test/helpers.js';
import {
  agentSessionName,
  lastReply,
  lastSessionIn,
  watchAgents,
  type AgentSession,
} from '../src/prs/agents.js';

describe('background agents', () => {
  let home: string | undefined;
  afterEach(() => home && rmSync(home, { recursive: true, force: true }));

  it('reads the last assistant text from the session transcript', () => {
    home = mkdtempSync(join(tmpdir(), 'brsorganizer-home-'));
    const session: AgentSession = {
      name: 'Todo-abc123',
      sessionId: '46f4befa-d052-456b-b836-de35d3c996fc',
      cwd: 'C:\\projects-git\\Kunde\\Todo-abc123',
      status: 'idle',
    };
    const dir = join(home, '.claude', 'projects', 'C--projects-git-Kunde-Todo-abc123');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${session.sessionId}.jsonl`),
      [
        { type: 'user', message: { content: 'Lies deinen Auftrag' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Erst mal schauen.' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
        'kein JSON',
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Welche Version ist gemeint?' }] },
        },
        { type: 'system', subtype: 'turn_duration' },
      ]
        .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
        .join('\n'),
    );
    expect(lastReply(session, home)).toBe('Welche Version ist gemeint?');
    expect(lastReply({ ...session, sessionId: 'unknown-session' }, home)).toBeNull();
  });

  it('puts the answer of a waiting session on its todo', async () => {
    const core = makeCore();
    const todo = core.items.addTodo({ title: 'A', notes: 'x' }, 'user');
    const other = core.items.addTodo({ title: 'B', notes: 'y' }, 'user');
    core.items.updateTodo(todo.id, { agentBranch: 'feature/a' }, 'user');
    core.items.updateTodo(other.id, { agentBranch: 'feature/b' }, 'user');
    const sessions: AgentSession[] = [
      {
        name: agentSessionName(todo.id),
        sessionId: 's-000001',
        cwd: 'C:\\a',
        status: 'idle',
        pid: 11,
      },
      {
        name: agentSessionName(other.id),
        sessionId: 's-000002',
        cwd: 'C:\\b',
        status: 'busy',
        pid: 12,
      },
    ];
    const reads: string[] = [];
    const watch = watchAgents(core, {
      list: async () => sessions,
      read: (s) => {
        reads.push(s.sessionId);
        return 'Welche Version ist gemeint?';
      },
      intervalMs: 60_000,
    });
    try {
      await watch.check();
      expect(reads).toEqual(['s-000001']); // a working session is not read
      expect(core.items.get(todo.id).meta).toMatchObject({
        agentReply: 'Welche Version ist gemeint?',
      });
      expect(core.items.get(todo.id).updatedBy).toBe('claude');
      expect(core.items.get(other.id).meta?.agentReply).toBeUndefined();

      // Same answer again: nothing changes.
      const before = core.items.get(todo.id).updatedAt;
      core.fakeClock.advance(60_000);
      await watch.check();
      expect(core.items.get(todo.id).updatedAt).toEqual(before);

      // Stuck on a permission prompt: shown until the session works on.
      sessions[1] = { ...sessions[1]!, status: 'waiting', waitingFor: 'permission prompt' };
      await watch.check();
      expect(core.items.get(other.id).meta?.agentWaiting).toBe('permission prompt');
      sessions[1] = { ...sessions[1]!, status: 'busy', waitingFor: undefined };
      await watch.check();
      expect(core.items.get(other.id).meta?.agentWaiting).toBeUndefined();

      // Session gone: ended only after two checks in a row (a new one may still be starting).
      const gone = sessions.splice(1, 1)[0]!;
      await watch.check();
      expect(core.items.get(other.id).meta?.agentEnded).toBeUndefined();
      await watch.check();
      expect(core.items.get(other.id).meta?.agentEnded).toBe(true);
      sessions.push(gone); // resumed
      await watch.check();
      expect(core.items.get(other.id).meta?.agentEnded).toBeUndefined();
    } finally {
      watch.stop();
    }
  });

  it('sees a session ended by a restart, checking right at start', async () => {
    const core = makeCore();
    const todo = core.items.addTodo({ title: 'A', notes: 'x' }, 'user');
    core.items.updateTodo(todo.id, { agentBranch: 'feature/a', agentReply: 'Analyse …' }, 'user');
    const name = agentSessionName(todo.id);
    // As `claude agents --json --all` lists them after a reboot: no pid, no status.
    const sessions = [
      { name, sessionId: 's-000001', cwd: 'C:\\a', state: 'done' },
    ] as AgentSession[];
    let listed = 0;
    const watch = watchAgents(core, {
      list: async () => {
        listed++;
        return sessions;
      },
      read: () => null,
      intervalMs: 60_000,
    });
    try {
      await watch.check(); // waits for the check started with the watch
      expect(listed).toBe(1);
      await watch.check();
      expect(core.items.get(todo.id).meta).toMatchObject({ agentEnded: true });

      // A live idle session also reports state "done"; its pid tells it runs (resumed).
      sessions[0] = { name, sessionId: 's-000001', cwd: 'C:\\a', status: 'idle', pid: 7 };
      await watch.check();
      expect(core.items.get(todo.id).meta?.agentEnded).toBeUndefined();
    } finally {
      watch.stop();
    }
  });

  it('keeps the last answer of a session that ended, so "Claude pausiert" shows where it stopped', async () => {
    const core = makeCore();
    const todo = core.items.addTodo({ title: 'A', notes: 'x' }, 'user');
    core.items.updateTodo(todo.id, { agentBranch: 'feature/a' }, 'user');
    const name = agentSessionName(todo.id);
    // Ended (window closed, restart): listed without pid; the newest run counts.
    const sessions = [
      { name, sessionId: 's-old', cwd: 'C:\\a', startedAt: 1 },
      { name, sessionId: 's-new', cwd: 'C:\\a', startedAt: 2 },
    ] as AgentSession[];
    const reads: string[] = [];
    const watch = watchAgents(core, {
      list: async () => sessions,
      read: (s) => {
        reads.push(s.sessionId);
        return `Stand von ${s.sessionId}`;
      },
      intervalMs: 60_000,
      upstream: async () => null,
    });
    try {
      await watch.check();
      await watch.check();
      expect(core.items.get(todo.id).meta).toMatchObject({
        agentEnded: true,
        agentReply: 'Stand von s-new',
      });
      await watch.check();
      expect(reads).toEqual(['s-new']); // read once, not every interval
    } finally {
      watch.stop();
    }
  });

  it('finds the last session of a folder by its newest transcript', () => {
    home = mkdtempSync(join(tmpdir(), 'brsorganizer-home-'));
    const cwd = 'C:\\projects\\CFL\\Todo-cwga8n';
    expect(lastSessionIn(cwd, home)).toBeNull();
    const dir = join(home, '.claude', 'projects', 'C--projects-CFL-Todo-cwga8n');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'aaaaaaaa-old.jsonl'), '');
    writeFileSync(join(dir, 'bbbbbbbb-new.jsonl'), '');
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'aaaaaaaa-old.jsonl'), past, past);
    expect(lastSessionIn(`${cwd}\\`, home)).toEqual({ sessionId: 'bbbbbbbb-new', cwd: `${cwd}\\` });
  });

  it('reads the last answer from the worktree when the ended session is no longer listed', async () => {
    const core = makeCore();
    const todo = core.items.addTodo({ title: 'A', notes: 'x' }, 'user');
    core.items.updateTodo(todo.id, { agentBranch: 'feature/a', agentWorktree: 'C:\\w' }, 'user');
    const watch = watchAgents(core, {
      list: async () => [], // interactive session that ended: not listed any more
      lastSessionIn: (cwd) => ({ sessionId: 's-000077', cwd }),
      read: (s) => `Stand aus ${s.cwd} (${s.sessionId})`,
      intervalMs: 60_000,
      upstream: async () => null,
    });
    try {
      await watch.check();
      await watch.check();
      expect(core.items.get(todo.id).meta).toMatchObject({
        agentEnded: true,
        agentReply: 'Stand aus C:\\w (s-000077)',
      });
    } finally {
      watch.stop();
    }
  });

  it('checks again soon after a session was opened, not only every interval', async () => {
    const core = makeCore();
    const todo = core.items.addTodo({ title: 'A', notes: 'x' }, 'user');
    core.items.updateTodo(todo.id, { agentBranch: 'feature/a', agentEnded: true }, 'user');
    const name = agentSessionName(todo.id);
    let sessions: AgentSession[] = [];
    const watch = watchAgents(core, {
      list: async () => sessions,
      read: () => null,
      intervalMs: 60_000,
      soonMs: [5],
    });
    try {
      await watch.check();
      // Resumed in a console: running again, picked up by the quick check, not after a minute.
      sessions = [{ name, sessionId: 's-000002', cwd: 'C:\\a', status: 'busy', pid: 9 }];
      watch.soon();
      await new Promise((r) => setTimeout(r, 50));
      await watch.check(); // waits for the quick check if it still runs
      expect(core.items.get(todo.id).meta?.agentEnded).toBeUndefined();
    } finally {
      watch.stop();
    }
  });

  it('reports a finished turn once, so the PR can be synced right away', async () => {
    const core = makeCore();
    const todo = core.items.addTodo({ title: 'A', notes: 'x' }, 'user');
    core.items.updateTodo(todo.id, { agentBranch: 'feature/a' }, 'user');
    const name = agentSessionName(todo.id);
    let sessions: AgentSession[] = [
      { name, sessionId: 's-000001', cwd: 'C:\\a', status: 'busy', pid: 7 },
    ];
    let ended = 0;
    const watch = watchAgents(core, {
      list: async () => sessions,
      read: () => 'PR erstellt',
      intervalMs: 60_000,
      onPrChanged: () => ended++,
      upstream: async () => null,
    });
    try {
      await watch.check();
      expect(ended).toBe(0); // still working
      sessions = [{ ...sessions[0]!, status: 'idle' }];
      await watch.check();
      expect(ended).toBe(1);
      await watch.check(); // same answer: no new sync
      expect(ended).toBe(1);
      sessions = []; // ended (second missing check)
      await watch.check();
      await watch.check();
      expect(ended).toBe(2);
    } finally {
      watch.stop();
    }
  });

  it('reports a push of a PR session, also without agent todos', async () => {
    const core = makeCore();
    await core.sync.run(
      new StaticSource('tfs', [{ externalId: 'pr-1', type: 'pr', title: 'PR', link: null }]),
    );
    const sessions: AgentSession[] = [
      { name: 'PR1', sessionId: 's-000001', cwd: 'C:\\pr1', status: 'busy', pid: 7 },
      { name: 'eigene', sessionId: 's-000002', cwd: 'C:\\other', status: 'busy', pid: 8 },
    ];
    const heads: Record<string, string | null> = { 'C:\\pr1': 'aaa', 'C:\\other': 'x1' };
    let changed = 0;
    const watch = watchAgents(core, {
      list: async () => sessions,
      read: () => null,
      intervalMs: 60_000,
      onPrChanged: () => changed++,
      upstream: async (cwd) => heads[cwd] ?? null,
    });
    try {
      await watch.check();
      expect(changed).toBe(0); // first sight is no push
      heads['C:\\other'] = 'x2'; // not an agent session of the organizer
      await watch.check();
      expect(changed).toBe(0);
      heads['C:\\pr1'] = 'bbb'; // pushed
      await watch.check();
      expect(changed).toBe(1);
      await watch.check();
      expect(changed).toBe(1);
    } finally {
      watch.stop();
    }
  });
});
