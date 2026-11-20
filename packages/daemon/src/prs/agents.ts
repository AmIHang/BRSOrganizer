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
  status: z.string().optional(),
  waitingFor: z.string().optional(),
  /** Process of a live session. Ended ones (also after a reboot) are listed without pid and status. */
  pid: z.number().optional(),
  /** "done" / "blocked" – also "done" for a live idle session, so not a sign of having ended. */
  state: z.string().optional(),
});
export type AgentSession = z.infer<typeof sessionSchema>;

/**
 * Whether the session still runs. Not `state`: a live idle session also reports "done"
 * (claude 2.1.327); the process id is what an ended one lacks.
 */
export const sessionAlive = (s: AgentSession) => s.pid !== undefined || s.status === 'busy';

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
 * the todo (`meta.agentReply`), for the app to show. Also notices pushes of agent sessions
 * (todo or PR) and reports them through `onPrChanged`.
 */
export function watchAgents(
  core: Core,
  options: {
    list: ListAgentSessions;
    read?: (s: AgentSession) => string | null;
    intervalMs?: number;
    /** Delays of the quick checks after `soon()` (tests). */
    soonMs?: number[];
    log?: (msg: string, extra?: Record<string, unknown>) => void;
    /**
     * A session finished its turn with a new answer, ended, or pushed. Its PR is likely new or
     * changed: syncing now updates it (or turns the todo into it) without waiting for the
     * next scheduled sync.
     */
    onPrChanged?: () => void;
    /** Commit of the upstream branch checked out in `cwd`, null without one (tests). */
    upstream?: (cwd: string) => Promise<string | null>;
  },
): { check(): Promise<void>; soon(): void; stop(): void } {
  const read = options.read ?? ((s) => lastReply(s));
  const upstream =
    options.upstream ??
    ((cwd) =>
      new Promise<string | null>((resolve) =>
        execFile(
          'git',
          ['-C', cwd, 'rev-parse', '@{u}'],
          { windowsHide: true, timeout: 10_000 },
          (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
        ),
      ));
  // Upstream commit per agent session: a push moves it (git updates origin/<branch> locally).
  const pushedAt = new Map<string, string | null>();
  // Checks in a row a todo's session was missing: one alone may be a session still starting.
  const missing = new Map<string, number>();
  // A check while one runs waits for that one instead of starting a second.
  let running: Promise<void> | null = null;
  const check = () => (running ??= run().finally(() => (running = null)));
  const run = async () => {
    const todos = core.items
      .list({ type: 'todo', limit: 500 })
      .filter((t) => typeof t.meta?.agentBranch === 'string');
    // Without agent todos or open PRs there is nothing a session could change.
    if (!todos.length && !core.items.list({ type: 'pr', limit: 1 }).length) return;
    let prChanged = false;
    try {
      const sessions = await options.list();
      for (const s of sessions) {
        if (!s.name || !/^(Todo-[0-9a-z]{6}|PR\d+)$/i.test(s.name) || !sessionAlive(s)) continue;
        const sha = await upstream(s.cwd);
        // First sight is no push; a new upstream (first push with -u) or a moved one is.
        if (pushedAt.has(s.name) && pushedAt.get(s.name) !== sha && sha !== null) prChanged = true;
        pushedAt.set(s.name, sha);
      }
      for (const todo of todos) {
        const name = agentSessionName(todo.id);
        const s = sessions.find((x) => x.name === name && sessionAlive(x));
        const ended = todo.meta?.agentEnded === true;
        if (!s) {
          // Gone without a PR (crashed, stopped elsewhere, reboot): the todo must not look busy.
          const n = (missing.get(todo.id) ?? 0) + 1;
          missing.set(todo.id, n);
          if (n >= 2 && !ended) {
            core.items.updateTodo(todo.id, { agentEnded: true, agentWaiting: null }, 'claude');
            prChanged = true;
          }
          continue;
        }
        missing.delete(todo.id);
        if (ended) core.items.updateTodo(todo.id, { agentEnded: null }, 'claude'); // resumed
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
          prChanged = true;
        }
      }
    } catch (err) {
      options.log?.('could not check the agent sessions', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (prChanged) options.onPrChanged?.();
  };
  const timer = setInterval(() => void check(), options.intervalMs ?? 30_000);
  timer.unref();
  // Right away too: after a restart the todos would otherwise look busy for a while.
  void check();
  // After the user resumed a session: a few quick checks while it comes up, instead of waiting up
  // to a whole interval until "Claude pausiert" turns back into "Claude arbeitet".
  const soon = () => {
    for (const ms of options.soonMs ?? [3_000, 10_000, 20_000]) {
      setTimeout(() => void check(), ms).unref();
    }
  };
  return { check, soon, stop: () => clearInterval(timer) };
}
