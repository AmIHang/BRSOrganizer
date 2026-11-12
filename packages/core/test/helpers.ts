import { createCore, type Core, type CoreOptions } from '../src/core.js';
import type { Clock } from '../src/clock.js';
import { MemorySecretStore } from '../src/secrets/store.js';
import type { ExternalItem, SyncSource } from '../src/sync/engine.js';
import type { ExternalSource } from '../src/db/schema.js';

export class FakeClock implements Clock {
  private t: number;

  constructor(start: string | Date = '2026-11-12T08:00:00.000Z') {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(at: string | Date): void {
    this.t = new Date(at).getTime();
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function makeCore(options: Partial<CoreOptions> = {}): Core & { fakeClock: FakeClock } {
  const fakeClock = (options.clock as FakeClock | undefined) ?? new FakeClock();
  const core = createCore({
    databaseFile: ':memory:',
    secrets: new MemorySecretStore(),
    ...options,
    clock: fakeClock,
  });
  return Object.assign(core, { fakeClock });
}

/** A source whose snapshot the test controls. */
export class StaticSource implements SyncSource {
  calls = 0;
  failWith: Error | null = null;

  constructor(
    readonly id: ExternalSource,
    public snapshot: ExternalItem[] = [],
  ) {}

  async fetchSnapshot(): Promise<ExternalItem[]> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return structuredClone(this.snapshot);
  }
}

export function pr(id: string, overrides: Partial<ExternalItem> = {}): ExternalItem {
  return {
    externalId: id,
    type: 'pr',
    title: `PR ${id}`,
    link: `https://github.com/acme/repo/pull/${id}`,
    meta: { repo: 'acme/repo', reasons: ['review-requested'] },
    ...overrides,
  };
}
