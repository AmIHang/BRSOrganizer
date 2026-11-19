import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeCore } from '../../core/test/helpers.js';
import { agentSessionName, lastReply, watchAgents, type AgentSession } from '../src/prs/agents.js';

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
});
