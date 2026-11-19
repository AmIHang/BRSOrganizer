import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from './clock.js';
import type { Db } from './db/client.js';
import { settings } from './db/schema.js';
import { ValidationError } from './errors.js';

const projectName = z.string().trim().min(1).max(100);

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
      /** On by default: it only runs once a collection URL is set. */
      enabled: z.boolean().default(true),
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
      /** Projects added by hand (customer folder names), next to those from pull requests. */
      projects: z.array(projectName).max(200).default([]),
      /** Projects from pull requests the user removed from the list. */
      hiddenProjects: z.array(projectName).max(500).default([]),
      /** OTMA project ("STB BRS [STBBRS]") → customer folder, for todos taken over from OTMA. */
      otmaProjects: z
        .record(z.string().trim().min(1).max(300), projectName)
        .refine((m) => Object.keys(m).length <= 500, 'too many OTMA projects')
        .default({}),
      /** BSM ticket prefix ("STBBRS" of "STBBRSg0034") → customer folder; a customer's tickets share it. */
      bsmProjects: z
        .record(z.string().trim().min(1).max(100), projectName)
        .refine((m) => Object.keys(m).length <= 500, 'too many BSM prefixes')
        .default({}),
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
  /** View state of the app that survives a restart. */
  ui: z
    .object({
      /** Folded parts of the list, e.g. "section:reviews" or "project:Community". */
      collapsed: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
      /** Items (PRs, todos) the user put on hold: shown greyed out, compact and last. */
      onHold: z.array(z.string().trim().min(1).max(200)).max(1000).default([]),
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
  workspace: z
    .strictObject({
      projectsRoot: z.string(),
      projects: z.array(z.string()),
      hiddenProjects: z.array(z.string()),
      otmaProjects: z.record(z.string(), z.string()),
      bsmProjects: z.record(z.string(), z.string()),
    })
    .partial()
    .optional(),
  mail: z
    .strictObject({ enabled: z.boolean(), outlookFolder: z.string(), lookBackDays: z.number() })
    .partial()
    .optional(),
  ui: z
    .strictObject({ collapsed: z.array(z.string()), onHold: z.array(z.string()) })
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

  /** False on a fresh installation (nothing saved yet): the daemon then applies detected defaults. */
  isStored(): boolean {
    return this.db.select().from(settings).where(eq(settings.key, KEY)).get() !== undefined;
  }

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
      ui: { ...current.ui, ...patch.ui },
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
