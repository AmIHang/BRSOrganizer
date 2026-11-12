import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from './clock.js';
import type { Db } from './db/client.js';
import { settings } from './db/schema.js';
import { ValidationError } from './errors.js';

export const settingsSchema = z.object({
  syncIntervalMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(5),
  daemonPort: z.number().int().min(1024).max(65535).default(47821),
  github: z
    .object({
      enabled: z.boolean().default(true),
      /** Review requests are always included; these add more searches. */
      includeAuthored: z.boolean().default(true),
      includeAssigned: z.boolean().default(true),
    })
    .prefault({}),
  calendar: z
    .object({
      enabled: z.boolean().default(true),
      lookAheadDays: z.number().int().min(1).max(90).default(14),
    })
    .prefault({}),
});

export type Settings = z.output<typeof settingsSchema>;
export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K];
};

const KEY = 'app';

/** Non-secret configuration. Secrets go to the SecretStore. */
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get(): Settings {
    const row = this.db.select().from(settings).where(eq(settings.key, KEY)).get();
    const parsed = settingsSchema.safeParse(row?.value ?? {});
    // A stored value that no longer validates (older version) falls back to defaults.
    return parsed.success ? parsed.data : settingsSchema.parse({});
  }

  update(patch: SettingsPatch): Settings {
    const current = this.get();
    const merged = {
      ...current,
      ...patch,
      github: { ...current.github, ...patch.github },
      calendar: { ...current.calendar, ...patch.calendar },
    };
    const r = settingsSchema.safeParse(merged);
    if (!r.success) throw new ValidationError(z.prettifyError(r.error));
    const now = this.clock.now();
    this.db
      .insert(settings)
      .values({ key: KEY, value: r.data, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: r.data, updatedAt: now } })
      .run();
    return r.data;
  }
}
