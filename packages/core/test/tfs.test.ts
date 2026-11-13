import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/secrets/store.js';
import { normalizeCollectionUrl, patTransport, type TfsTransport } from '../src/sync/tfs.js';
import { makeCore, type FakeClock } from './helpers.js';
import type { PrMail } from '../src/sync/mail-prs.js';

const BASE = 'https://tfs.example.com/tfs/boom';
const ME = { id: 'me-id', displayName: 'Muster Max' };
const OTHER = { id: 'other-id', displayName: 'Kollege Karl' };

interface FakePr {
  id: number;
  title?: string;
  project?: string;
  repo?: string;
  creator?: typeof ME;
  myVote?: number | null;
  draft?: boolean;
}

function apiPr(p: FakePr) {
  const project = p.project ?? 'Produktion';
  const repo = p.repo ?? 'Community';
  return {
    pullRequestId: p.id,
    title: p.title ?? `PR ${p.id}`,
    status: 'active',
    isDraft: p.draft ?? false,
    creationDate: '2026-11-12T10:00:00Z',
    createdBy: p.creator ?? OTHER,
    targetRefName: 'refs/heads/main',
    repository: {
      name: repo,
      webUrl: `${BASE}/${project}/_git/${repo}`,
      project: { name: project },
    },
    reviewers: p.myVote === null || p.myVote === undefined ? [] : [{ ...ME, vote: p.myVote }],
  };
}

/** Fake Azure DevOps: answers connectionData and the two PR searches. */
function fakeTfs(state: { prs: FakePr[]; fail?: boolean }) {
  const calls: string[] = [];
  const transport: TfsTransport = async (urls) => {
    if (state.fail) throw new Error('Azure DevOps (Windows login) could not be read: 401');
    return urls.map((url) => {
      calls.push(url);
      if (url.endsWith('/_apis/connectionData')) return { authenticatedUser: ME };
      const u = new URL(url);
      const reviewer = u.searchParams.get('searchCriteria.reviewerId');
      const creator = u.searchParams.get('searchCriteria.creatorId');
      const value = state.prs
        .filter((p) =>
          reviewer
            ? p.myVote !== null && p.myVote !== undefined
            : (p.creator ?? OTHER).id === creator,
        )
        .map(apiPr);
      return { count: value.length, value };
    });
  };
  return { transport, calls };
}

function setup(state: { prs: FakePr[]; fail?: boolean }, pat: string | null = null) {
  const fake = fakeTfs(state);
  const pats: Array<string | null> = [];
  const core = makeCore({
    secrets: new MemorySecretStore(pat ? { 'tfs-token': pat } : {}),
    tfsTransport: (p) => {
      pats.push(p);
      return fake.transport;
    },
  });
  core.settings.update({
    github: { enabled: false },
    calendar: { enabled: false },
    tfs: { enabled: true, collectionUrl: `${BASE}/` },
  });
  return { core, calls: fake.calls, pats };
}

describe('TFS source', () => {
  it('lists review requests and own PRs with vote, draft and link', async () => {
    const state = {
      prs: [
        { id: 1, myVote: 0, title: 'Please review' },
        { id: 2, myVote: 10 },
        { id: 3, creator: ME, draft: true },
        { id: 4, creator: ME, myVote: 0 }, // own PR, self-added as reviewer
      ],
    };
    const { core, calls } = setup(state);
    try {
      const r = await core.syncAll();
      expect(r.status).toMatchObject({ tfs: 'ready' });
      expect(r.results).toMatchObject([{ source: 'tfs', ok: true, added: 4 }]);

      const prs = Object.fromEntries(
        core.items.list({ type: 'pr' }).map((i) => [i.meta?.number, i]),
      );
      expect(prs[1]).toMatchObject({
        source: 'tfs',
        title: 'Please review',
        externalId: 'tfs.example.com/boom/produktion/community/1',
        link: `${BASE}/Produktion/_git/Community/pullrequest/1`,
        meta: { reasons: ['review-requested'], myVote: 'no-vote', author: 'Kollege Karl' },
      });
      expect(prs[2]!.meta).toMatchObject({ reasons: ['reviewed'], myVote: 'approved' });
      expect(prs[3]!.meta).toMatchObject({ reasons: ['authored'], draft: true });
      expect(prs[4]!.meta).toMatchObject({ reasons: ['authored'] });

      // Collection-level queries only, trailing slash normalized.
      expect(calls.every((c) => c.startsWith(`${BASE}/_apis/`))).toBe(true);
    } finally {
      core.close();
    }
  });

  it('removes completed PRs and keeps everything when TFS is unreachable', async () => {
    const state: { prs: FakePr[]; fail?: boolean } = {
      prs: [
        { id: 1, myVote: 0 },
        { id: 2, myVote: 0 },
      ],
    };
    const { core } = setup(state);
    try {
      await core.syncAll();
      state.prs = [{ id: 2, myVote: 0 }]; // #1 completed
      expect((await core.syncAll()).results).toMatchObject([{ closed: 1 }]);

      state.fail = true;
      expect((await core.syncAll()).results).toMatchObject([{ ok: false, closed: 0 }]);
      expect(core.items.list({ type: 'pr' }).map((i) => i.meta?.number)).toEqual([2]);
    } finally {
      core.close();
    }
  });

  it('uses the PAT when one is stored, otherwise the Windows login', async () => {
    const withPat = setup({ prs: [] }, 'pat-123');
    const without = setup({ prs: [] });
    try {
      await withPat.core.syncAll();
      await without.core.syncAll();
      expect(withPat.pats).toContain('pat-123');
      expect(without.pats).toEqual([null]);
    } finally {
      withPat.core.close();
      without.core.close();
    }
  });

  it('skips the own-PR query when disabled', async () => {
    const { core, calls } = setup({ prs: [{ id: 3, creator: ME }] });
    core.settings.update({ tfs: { includeAuthored: false } });
    try {
      await core.syncAll();
      expect(calls.some((c) => c.includes('creatorId'))).toBe(false);
      expect(core.items.list({ type: 'pr' })).toEqual([]);
    } finally {
      core.close();
    }
  });
});

describe('mail fallback', () => {
  const mail = (id: number, line: string): PrMail => ({
    receivedAt: '2026-11-12T09:00:00.000Z',
    subject: `PR – PR ${id} – Community ${id} (Kollege Karl)`,
    body: line,
    urls: [`${BASE}/Produktion/_git/Community/pullrequest/${id}`],
  });

  it('runs the mail source only while TFS is not configured, keeping the same items', async () => {
    const tfs = fakeTfs({ prs: [{ id: 1, myVote: 0 }] });
    const core = makeCore({
      tfsTransport: () => tfs.transport,
      mailboxReader: async () => ({
        me: 'Muster Max',
        mails: [mail(1, 'Kollege Karl und Muster Max wurden als Reviewer hinzugefügt.')],
      }),
    });
    (core.fakeClock as FakeClock).set('2026-11-12T12:00:00.000Z');
    core.settings.update({
      github: { enabled: false },
      calendar: { enabled: false },
      mail: { enabled: true },
    });
    try {
      // Fallback: mail.
      expect(core.sourceStatus()).toMatchObject({ tfs: 'disabled', mail: 'ready' });
      await core.syncAll();
      const [fromMail] = core.items.list({ type: 'pr' });
      expect(fromMail).toMatchObject({ source: 'tfs' });

      // TFS configured: mail goes to standby, the same PR keeps its item (no duplicate).
      core.settings.update({ tfs: { enabled: true, collectionUrl: BASE } });
      expect(core.sourceStatus()).toMatchObject({ tfs: 'ready', mail: 'standby' });
      const r = await core.syncAll();
      expect(r.results).toHaveLength(1);
      expect(r.results[0]).toMatchObject({ source: 'tfs', added: 0, closed: 0 });
      const after = core.items.list({ type: 'pr' });
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(fromMail!.id);
      expect(after[0]!.link).toBe(`${BASE}/Produktion/_git/Community/pullrequest/1`);
    } finally {
      core.close();
    }
  });

  it('reports a missing collection URL', () => {
    const core = makeCore();
    core.settings.update({ tfs: { enabled: true } });
    try {
      expect(core.sourceStatus().tfs).toBe('missing-url');
    } finally {
      core.close();
    }
  });
});

describe('helpers', () => {
  it('normalizes the collection URL', () => {
    expect(normalizeCollectionUrl(' https://tfs.example.com/tfs/boom/?x=1 ')).toBe(BASE);
    expect(() => normalizeCollectionUrl('ftp://x')).toThrow();
  });

  it('sends the PAT as basic auth and never in the error message', async () => {
    const seen: string[] = [];
    const transport = patTransport('secret-pat', (async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response('{}', { status: 401 });
    }) as typeof fetch);
    const err = await transport([`${BASE}/_apis/connectionData`]).catch((e: Error) => e);
    expect(seen).toEqual([`Basic ${Buffer.from(':secret-pat').toString('base64')}`]);
    expect((err as Error).message).toBe('Azure DevOps request failed: HTTP 401');
  });
});
