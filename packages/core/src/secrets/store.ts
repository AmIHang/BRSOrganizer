import { randomBytes } from 'node:crypto';

export const SECRET_KEYS = ['github-token', 'calendar-ics-url', 'local-access-token'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** Storage for secrets. Production: Windows Credential Manager. Never the DB. */
export interface SecretStore {
  get(key: SecretKey): string | null;
  set(key: SecretKey, value: string): void;
  /** Returns true if something was deleted. */
  delete(key: SecretKey): boolean;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<SecretKey, string>();

  constructor(initial: Partial<Record<SecretKey, string>> = {}) {
    for (const [k, v] of Object.entries(initial)) this.values.set(k as SecretKey, v);
  }

  get(key: SecretKey): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: SecretKey, value: string): void {
    this.values.set(key, value);
  }

  delete(key: SecretKey): boolean {
    return this.values.delete(key);
  }
}

/** Token that local clients (app, mcp-stdio) must present to the daemon. Created on first use. */
export function getOrCreateAccessToken(store: SecretStore): string {
  const existing = store.get('local-access-token');
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  store.set('local-access-token', token);
  return token;
}
