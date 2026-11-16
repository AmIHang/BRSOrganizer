import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Core, SettingsPatch } from '@amineeded/core';
import { scanRepos } from './prs/workspace.js';

export interface FirstRunEnv {
  outlookInstalled: () => boolean;
  /** Folders that may hold <customer>\<repo> checkouts, most likely first. */
  projectRootCandidates: string[];
  /** Does the folder contain customer folders with git repos? */
  hasRepos: (dir: string) => boolean;
}

export const windowsFirstRunEnv: FirstRunEnv = {
  outlookInstalled: () => {
    try {
      execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE'],
        { stdio: 'ignore', windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  },
  projectRootCandidates: [
    'C:\\projects-git',
    'D:\\projects-git',
    join(homedir(), 'source', 'repos'),
    join(homedir(), 'projects-git'),
  ],
  hasRepos: (dir) => scanRepos(dir).length > 0,
};

/**
 * On a fresh installation (no settings saved yet), pick what this machine already has: the
 * classic Outlook calendar and a projects folder with customer repos. Afterwards the user only
 * enters the TFS collection URL. Returns the applied patch (empty when settings existed).
 */
export function applyFirstRunDefaults(
  core: Core,
  env: FirstRunEnv = windowsFirstRunEnv,
): SettingsPatch {
  if (core.settings.isStored()) return {};
  const patch: SettingsPatch = {};
  if (env.outlookInstalled()) patch.calendar = { provider: 'outlook' };
  const root = env.projectRootCandidates.find((d) => env.hasRepos(d));
  if (root) patch.workspace = { projectsRoot: root };
  // Saving also marks the installation as initialized, so this runs only once.
  core.settings.update(patch);
  return patch;
}
