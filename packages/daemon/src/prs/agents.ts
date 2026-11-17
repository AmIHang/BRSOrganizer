import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '@brsorganizer/core';
import { z } from 'zod';

/** Name of the claude background session a todo is handed to (also its worktree folder). */
export const agentSessionName = (todoId: string) => `Todo-${todoId.slice(-6).toLowerCase()}`;

const sessionSchema = z.object({
  name: z.string().optional(),
  sessionId: z.string().regex(/^[\w-]{8,100}$/),
  cwd: z.string(),
  /**
   * "busy": working; "idle": finished its turn and waits for the user; "waiting": stuck mid-turn
   * on something only the user can answer (`waitingFor`, e.g. "permission prompt").
   */
  status: z.string(),
  waitingFor: z.string().optional(),
});
export type AgentSession = z.infer<typeof sessionSchema>;

/** Lists claude's sessions (`claude agents --json --all`). */
export type ListAgentSessions = () => Promise<AgentSession[]>;

// shortcut: only the native installer's claude.exe or one on PATH, not an npm claude.cmd
// (would need a shell); extend if someone installs it that way.
function claudeExe(): string {
  const local = join(homedir(), '.local', 'bin', 'claude.exe');
  return existsSync(local) ? local : 'claude.exe';
}

/** Stops a background session by name (`claude stop <name>`). */
export type StopAgentSession = (name: string) => Promise<void>;

export function claudeStopCli(): StopAgentSession {
  return (name) =>
    new Promise((resolve) =>
      // An unknown name (e.g. claude ran in its own window instead) is fine: nothing to stop.
      execFile(claudeExe(), ['stop', name], { windowsHide: true, timeout: 30_000 }, () =>
        resolve(),
      ),
    );
}

export function claudeAgentsCli(): ListAgentSessions {
  const claude = claudeExe();
  return () =>
    new Promise((resolve, reject) =>
      execFile(
        claude,
        ['agents', '--json', '--all'],
        { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err);
          try {
            resolve(
              z
                .array(z.unknown())
                .parse(JSON.parse(stdout))
                .flatMap((s) => {
                  const r = sessionSchema.safeParse(s);
                  return r.success ? [r.data] : [];
                }),
            );
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
      ),
    );
}

/** The session's last answer: text of the last assistant message in its transcript. */
export function lastReply(session: AgentSession, home = homedir()): string | null {
  const file = join(
    home,
    '.claude',
    'projects',
    session.cwd.replace(/[^A-Za-z0-9]/g, '-'),
    `${session.sessionId}.jsonl`,
  );
  if (!existsSync(file)) return null;
  let reply: string | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let entry: { type?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    const text = (entry.message.content as Array<{ type?: unknown; text?: unknown }>)
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim();
    if (text) reply = text;
  }
  return reply && reply.slice(0, 20_000);
}

/**
 * Watches the background sessions of todos handed to an agent: when one finished its turn
 * (waits for the user, e.g. with a question or a result without a PR), its last answer goes on
 * the todo (`meta.agentReply`), for the app to show.
 */
export function watchAgents(
  core: Core,
  options: {
    list: ListAgentSessions;
    read?: (s: AgentSession) => string | null;
    intervalMs?: number;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
  },
): { check(): Promise<void>; stop(): void } {
  const read = options.read ?? ((s) => lastReply(s));
  let running = false;
  const check = async () => {
    const todos = core.items
      .list({ type: 'todo', limit: 500 })
      .filter((t) => typeof t.meta?.agentBranch === 'string');
    if (!todos.length || running) return;
    running = true;
    try {
      const sessions = await options.list();
      for (const todo of todos) {
        const name = agentSessionName(todo.id);
        const s = sessions.find((x) => x.name === name);
        if (!s) continue;
        // Mid-turn question or permission prompt: without a hint the user would wait forever.
        const waiting =
          s.status === 'waiting' ? (s.waitingFor?.trim() || 'Eingabe').slice(0, 200) : null;
        const stored = typeof todo.meta?.agentWaiting === 'string' ? todo.meta.agentWaiting : null;
        if (waiting !== stored) {
          core.items.updateTodo(todo.id, { agentWaiting: waiting }, 'claude');
        }
        if (s.status !== 'idle') continue;
        const reply = read(s);
        if (reply && reply !== todo.meta?.agentReply) {
          core.items.updateTodo(todo.id, { agentReply: reply }, 'claude');
        }
      }
    } catch (err) {
      options.log?.('could not check the agent sessions', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void check(), options.intervalMs ?? 30_000);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}
