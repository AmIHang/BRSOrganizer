import type { Core, SourceStatus, SyncResult } from '@brsorganizer/core';
import type { Logger } from 'pino';

export interface SyncAllResult {
  results: SyncResult[];
  status: SourceStatus;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Runs a sync now; concurrent callers share the same run. Re-arms the timer afterwards. */
  runNow(): Promise<SyncAllResult>;
  nextRunAt(): Date | null;
  /** Re-reads the interval (after a settings change). `runSoon` also syncs shortly. */
  reschedule(options?: { runSoon?: boolean }): void;
}

export interface SchedulerOptions {
  core: Core;
  logger: Logger;
  /** Delay of the first sync after start and of `runSoon`. */
  initialDelayMs?: number;
}

export function createScheduler({
  core,
  logger,
  initialDelayMs = 3_000,
}: SchedulerOptions): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let next: Date | null = null;
  let running: Promise<SyncAllResult> | null = null;
  let started = false;

  const intervalMs = () => core.settings.get().syncIntervalMinutes * 60_000;

  const arm = (delayMs: number) => {
    if (!started) return;
    if (timer) clearTimeout(timer);
    next = new Date(core.clock.now().getTime() + delayMs);
    timer = setTimeout(() => {
      runNow().catch((err: unknown) => logger.error({ err }, 'scheduled sync crashed'));
    }, delayMs);
    timer.unref();
  };

  const runNow = (): Promise<SyncAllResult> => {
    if (running) return running;
    if (timer) clearTimeout(timer);
    timer = null;
    next = null;
    running = core
      .syncAll()
      .then((r) => {
        for (const res of r.results) {
          const fields = {
            source: res.source,
            added: res.added,
            updated: res.updated,
            closed: res.closed,
            reopened: res.reopened,
          };
          if (res.ok) logger.info(fields, 'sync finished');
          else logger.warn({ ...fields, error: res.error }, 'sync failed');
        }
        return r;
      })
      .finally(() => {
        running = null;
        arm(intervalMs());
      });
    return running;
  };

  return {
    start() {
      if (started) return;
      started = true;
      arm(initialDelayMs);
    },
    stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      next = null;
    },
    runNow,
    nextRunAt: () => next,
    reschedule(options = {}) {
      if (running) return; // re-armed when the current run finishes
      arm(options.runSoon ? initialDelayMs : intervalMs());
    },
  };
}
