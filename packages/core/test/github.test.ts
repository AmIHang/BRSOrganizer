import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/secrets/store.js';
import { GithubSource, type GraphqlClient, type SearchResponse } from '../src/sync/github.js';
import { makeCore } from './helpers.js';

type Node = SearchResponse['search']['nodes'][number];

function node(id: string, extra: Partial<Node> = {}): Node {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `Title ${id}`,
    url: `https://github.com/acme/app/pull/${id}`,
    isDraft: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
    reviewDecision: 'REVIEW_REQUIRED',
    author: { login: 'alice' },
    repository: { nameWithOwner: 'acme/app' },
    ...extra,
  };
}

/** Fake GraphQL: maps the search query (by qualifier) to pages of nodes. */
function fakeGql(pages: Record<string, Node[][]>) {
  const calls: { q: string; after: unknown }[] = [];
  const gql: GraphqlClient = async <T>(_query: string, vars: Record<string, unknown>) => {
    const q = String(vars.q);
    calls.push({ q, after: vars.after });
    const key = Object.keys(pages).find((k) => q.includes(k));
    const list = key ? pages[key]! : [[]];
    const index = vars.after ? Number(vars.after) : 0;
    return {
      search: {
        pageInfo: {
          hasNextPage: index < list.length - 1,
          endCursor: index < list.length - 1 ? String(index + 1) : null,
        },
        nodes: list[index] ?? [],
      },
    } as T;
  };
  return { gql, calls };
}

describe('GithubSource', () => {
  it('merges the searches and records why a PR is listed', async () => {
    const { gql } = fakeGql({
      'review-requested:@me': [[node('PR1'), node('PR2')]],
      'assignee:@me': [[node('PR2')]],
      'author:@me': [[node('PR3', { author: { login: 'me' }, reviewDecision: 'APPROVED' })]],
    });
    const items = await new GithubSource(gql, {
      includeAssigned: true,
      includeAuthored: true,
    }).fetchSnapshot();

    expect(items.map((i) => i.externalId)).toEqual(['PR1', 'PR2', 'PR3']);
    expect(items[1]).toMatchObject({
      type: 'pr',
      title: 'Title PR2',
      link: 'https://github.com/acme/app/pull/PR2',
      meta: { repo: 'acme/app', reasons: ['review-requested', 'assigned'] },
    });
    expect(items[2]!.meta).toMatchObject({ reasons: ['authored'], reviewDecision: 'APPROVED' });
  });

  it('only searches review requests when the extras are off', async () => {
    const { gql, calls } = fakeGql({ 'review-requested:@me': [[node('PR1')]] });
    await new GithubSource(gql, { includeAssigned: false, includeAuthored: false }).fetchSnapshot();
    expect(calls.map((c) => c.q)).toEqual(['is:pr is:open archived:false review-requested:@me']);
  });

  it('follows pagination and skips non-PR nodes', async () => {
    const { gql, calls } = fakeGql({
      'review-requested:@me': [[node('PR1'), {} as Node], [node('PR2')]],
    });
    const items = await new GithubSource(gql, {
      includeAssigned: false,
      includeAuthored: false,
    }).fetchSnapshot();
    expect(items.map((i) => i.externalId)).toEqual(['PR1', 'PR2']);
    expect(calls.map((c) => c.after)).toEqual([null, '1']);
  });

  it('fails instead of returning a partial list when the page cap is hit', async () => {
    const { gql } = fakeGql({
      'review-requested:@me': [[node('PR1')], [node('PR2')], [node('PR3')]],
    });
    const source = new GithubSource(gql, {
      includeAssigned: false,
      includeAuthored: false,
      maxPages: 2,
    });
    await expect(source.fetchSnapshot()).rejects.toThrow(/refusing a partial sync/);
  });

  it('syncs end-to-end through createCore with the token from the secret store', async () => {
    const tokens: string[] = [];
    const { gql } = fakeGql({ 'review-requested:@me': [[node('PR1')]] });
    const core = makeCore({
      secrets: new MemorySecretStore({ 'github-token': 'ghp_test' }),
      graphqlFactory: (t) => {
        tokens.push(t);
        return gql;
      },
    });
    try {
      const { results, status } = await core.syncAll();
      expect(status.github).toBe('ready');
      expect(tokens).toEqual(['ghp_test']);
      expect(results).toMatchObject([{ source: 'github', ok: true, added: 1 }]);

      const again = await core.syncAll();
      expect(again.results).toMatchObject([{ added: 0, updated: 0, closed: 0 }]);
    } finally {
      core.close();
    }
  });
});
