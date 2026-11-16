import { describe, expect, it } from 'vitest';
import { makeCore } from '../../core/test/helpers.js';
import { applyFirstRunDefaults, type FirstRunEnv } from '../src/first-run.js';

const env = (over: Partial<FirstRunEnv> = {}): FirstRunEnv => ({
  outlookInstalled: () => true,
  projectRootCandidates: ['C:\\projects-git', 'D:\\projects-git'],
  hasRepos: (dir) => dir === 'D:\\projects-git',
  ...over,
});

describe('first-run defaults', () => {
  it('picks the Outlook calendar and the first projects folder with repos, once', () => {
    const core = makeCore();
    try {
      expect(core.settings.isStored()).toBe(false);
      expect(applyFirstRunDefaults(core, env())).toEqual({
        calendar: { provider: 'outlook' },
        workspace: { projectsRoot: 'D:\\projects-git' },
      });
      expect(core.settings.get()).toMatchObject({
        calendar: { provider: 'outlook' },
        workspace: { projectsRoot: 'D:\\projects-git' },
        tfs: { enabled: true, collectionUrl: '' },
      });

      // Never again: the user's later choices win.
      core.settings.update({ calendar: { provider: 'ics' } });
      expect(applyFirstRunDefaults(core, env())).toEqual({});
      expect(core.settings.get().calendar.provider).toBe('ics');
    } finally {
      core.close();
    }
  });

  it('keeps the plain defaults when nothing is found', () => {
    const core = makeCore();
    try {
      applyFirstRunDefaults(core, env({ outlookInstalled: () => false, hasRepos: () => false }));
      expect(core.settings.isStored()).toBe(true);
      expect(core.settings.get()).toMatchObject({
        calendar: { provider: 'ics' },
        workspace: { projectsRoot: '' },
      });
    } finally {
      core.close();
    }
  });
});
