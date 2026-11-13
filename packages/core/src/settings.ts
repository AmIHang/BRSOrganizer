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
      /** `ics`: feed URL from the Credential Manager; `outlook`: default calendar via COM. */
      provider: z.enum(['ics', 'outlook']).default('ics'),
      lookAheadDays: z.number().int().min(1).max(90).default(14),
    })
    .prefault({}),
  /** Azure DevOps / TFS pull requests via REST API. */
  tfs: z
    .object({
      enabled: z.boolean().default(false),
      /** e.g. https://tfs.example.com/tfs/DefaultCollection or https://dev.azure.com/org */
      collectionUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
      includeAuthored: z.boolean().default(true),
    })
    .prefault({}),
  /** Local PR checkouts (clone, build, IIS) under <projectsRoot>\<customer>\PR<nr>. */
  workspace: z
    .object({
      /** e.g. C:\projects-git; empty = feature off. Customer folders hold the repos. */
      projectsRoot: z.string().trim().max(260).default(''),
    })
    .prefault({}),
  /** Fallback when TFS is not configured: PRs from notification mails in an Outlook folder. */
  mail: z
    .object({
      enabled: z.boolean().default(false),
      /** Path below the mailbox root, e.g. "Posteingang/PR". */
      outlookFolder: z.string().trim().min(1).max(500).default('Posteingang/PR'),
      /** Only mails from this many days; older PRs without a closing mail drop out. */
      lookBackDays: z.number().int().min(1).max(365).default(90),
    })
    .prefault({}),
});

export type Settings = z.output<typeof settingsSchema>;

/** Shape of a partial update; unknown keys are rejected so typos do not pass silently. */
export const settingsPatchSchema = z.strictObject({
  syncIntervalMinutes: z.number().optional(),
  daemonPort: z.number().optional(),
  github: z
    .strictObject({
      enabled: z.boolean(),
      includeAuthored: z.boolean(),
      includeAssigned: z.boolean(),
    })
    .partial()
    .optional(),
  calendar: z
    .strictObject({
      enabled: z.boolean(),
      provider: z.enum(['ics', 'outlook']),
      lookAheadDays: z.number(),
    })
    .partial()
    .optional(),
  tfs: z
    .strictObject({
      enabled: z.boolean(),
      collectionUrl: z.string(),
      includeAuthored: z.boolean(),
    })
    .partial()
    .optional(),
  workspace: z.strictObject({ projectsRoot: z.string() }).partial().optional(),
  mail: z
    .strictObject({ enabled: z.boolean(), outlookFolder: z.string(), lookBackDays: z.number() })
    .partial()
    .optional(),
});
export type SettingsPatch = z.input<typeof settingsPatchSchema>;

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

  update(input: SettingsPatch): Settings {
    const p = settingsPatchSchema.safeParse(input);
    if (!p.success) throw new ValidationError(z.prettifyError(p.error));
    const patch = p.data;
    const current = this.get();
    const merged = {
      ...current,
      ...patch,
      github: { ...current.github, ...patch.github },
      calendar: { ...current.calendar, ...patch.calendar },
      tfs: { ...current.tfs, ...patch.tfs },
      workspace: { ...current.workspace, ...patch.workspace },
      mail: { ...current.mail, ...patch.mail },
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
