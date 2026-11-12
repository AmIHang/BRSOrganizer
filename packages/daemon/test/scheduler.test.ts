import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCore } from '../../core/test/helpers.js';
import { createScheduler } from '../src/scheduler.js';

describe('scheduler', () => {
  let core: ReturnType<typeof makeCore>;
  beforeEach(() => {
    vi.useFakeTimers();
    core = makeCore();
  });
  afterEach(() => {
    vi.useRealTimers();
    core.close();
  });

  const make = () =>
    createScheduler({ core, logger: pino({ level: 'silent' }), initialDelayMs: 1000 });

  it('syncs shortly after start and then every interval', async () => {
    const spy = vi.spyOn(core, 'syncAll');
    const s = make();
    s.start();
    expect(s.nextRunAt()?.toISOString()).toBe('2026-11-12T08:00:01.000Z');

    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('picks up a changed interval on reschedule', async () => {
    const spy = vi.spyOn(core, 'syncAll');
    const s = make();
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    core.settings.update({ syncIntervalMinutes: 1 });
    s.reschedule();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('shares concurrent runNow calls', async () => {
    const spy = vi.spyOn(core, 'syncAll');
    const s = make();
    const [a, b] = await Promise.all([s.runNow(), s.runNow()]);
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing after stop', async () => {
    const spy = vi.spyOn(core, 'syncAll');
    const s = make();
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(spy).not.toHaveBeenCalled();
    expect(s.nextRunAt()).toBeNull();
  });
});
