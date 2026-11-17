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
      { name: agentSessionName(todo.id), sessionId: 's-000001', cwd: 'C:\\a', status: 'idle' },
      { name: agentSessionName(other.id), sessionId: 's-000002', cwd: 'C:\\b', status: 'busy' },
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
    } finally {
      watch.stop();
    }
  });
});
