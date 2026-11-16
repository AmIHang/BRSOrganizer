import { Entry } from '@napi-rs/keyring';
import { APP_NAME } from '../paths.js';
import type { SecretKey, SecretStore } from './store.js';

/**
 * Windows Credential Manager (generic credentials, target `BRSOrganizer/<key>` style entries
 * managed by the keyring crate). Visible under "Anmeldeinformationsverwaltung".
 */
export class KeyringSecretStore implements SecretStore {
  constructor(private readonly service: string = APP_NAME) {}

  get(key: SecretKey): string | null {
    try {
      return this.entry(key).getPassword() ?? null;
    } catch {
      // Missing entries throw on some platforms; treat as "not set".
      return null;
    }
  }

  set(key: SecretKey, value: string): void {
    this.entry(key).setPassword(value);
  }

  delete(key: SecretKey): boolean {
    try {
      return this.entry(key).deleteCredential();
    } catch {
      return false;
    }
  }

  private entry(key: SecretKey): Entry {
    return new Entry(this.service, key);
  }
}
