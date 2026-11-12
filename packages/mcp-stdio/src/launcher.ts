import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Daemon entry point next to this package in the monorepo (overridable). */
export function defaultDaemonMain(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.AMINEEDED_DAEMON_MAIN) return env.AMINEEDED_DAEMON_MAIN;
  const candidate = fileURLToPath(new URL('../../daemon/dist/main.js', import.meta.url));
  return existsSync(candidate) ? candidate : null;
}

export async function isDaemonHealthy(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { app?: string };
    return body.app === 'AmINeeded';
  } catch {
    return false;
  }
}

/**
 * Starts the daemon detached (it outlives this proxy) and waits until it answers.
 * Concurrent starts are harmless: the daemon is single-instance and a second one exits.
 */
export async function startDaemon(options: {
  daemonMain: string;
  port: number;
  log: (m: string) => void;
  timeoutMs?: number;
}): Promise<boolean> {
  if (await isDaemonHealthy(options.port)) return true;
  options.log(`starting daemon: ${options.daemonMain}`);
  const child = spawn(process.execPath, [options.daemonMain, '--port', String(options.port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isDaemonHealthy(options.port)) return true;
  }
  options.log('daemon did not become healthy in time');
  return false;
}
