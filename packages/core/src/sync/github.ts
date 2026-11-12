import { graphql } from '@octokit/graphql';
import type { ExternalItem, SyncSource } from './engine.js';

/** Minimal GraphQL client signature, so tests can inject a fake. */
export type GraphqlClient = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

export function createGraphqlClient(token: string): GraphqlClient {
  const client = graphql.defaults({ headers: { authorization: `token ${token}` } });
  return <T>(query: string, variables: Record<string, unknown>) => client<T>(query, variables);
}

export type PrReason = 'review-requested' | 'authored' | 'assigned';

const SEARCHES: Record<PrReason, string> = {
  'review-requested': 'is:pr is:open archived:false review-requested:@me',
  authored: 'is:pr is:open archived:false author:@me',
  assigned: 'is:pr is:open archived:false assignee:@me',
};
const REASON_ORDER: PrReason[] = ['review-requested', 'assigned', 'authored'];

export const SEARCH_QUERY = /* GraphQL */ `
  query AmINeededPrSearch($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 50, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          id
          number
          title
          url
          isDraft
          createdAt
          updatedAt
          reviewDecision
          author {
            login
          }
          repository {
            nameWithOwner
          }
        }
      }
    }
  }
`;

interface PrNode {
  id?: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  reviewDecision: string | null;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
}

export interface SearchResponse {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: PrNode[];
  };
}

export interface GithubSourceOptions {
  includeAuthored: boolean;
  includeAssigned: boolean;
  /** Safety cap; exceeding it fails the sync instead of closing items past the cap. */
  maxPages?: number;
}

export class GithubSource implements SyncSource {
  readonly id = 'github' as const;

  constructor(
    private readonly gql: GraphqlClient,
    private readonly options: GithubSourceOptions,
  ) {}

  async fetchSnapshot(): Promise<ExternalItem[]> {
    const reasons: PrReason[] = ['review-requested'];
    if (this.options.includeAssigned) reasons.push('assigned');
    if (this.options.includeAuthored) reasons.push('authored');

    const byId = new Map<string, { node: PrNode; reasons: Set<PrReason> }>();
    for (const reason of reasons) {
      for (const node of await this.search(SEARCHES[reason])) {
        const entry = byId.get(node.id!) ?? { node, reasons: new Set<PrReason>() };
        entry.reasons.add(reason);
        byId.set(node.id!, entry);
      }
    }

    return [...byId.values()].map(({ node, reasons: r }) => toExternal(node, r));
  }

  private async search(q: string): Promise<PrNode[]> {
    const maxPages = this.options.maxPages ?? 5;
    const out: PrNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res: SearchResponse = await this.gql<SearchResponse>(SEARCH_QUERY, { q, after });
      // Non-PR search hits come back as empty objects.
      out.push(...res.search.nodes.filter((n) => typeof n.id === 'string'));
      if (!res.search.pageInfo.hasNextPage) return out;
      after = res.search.pageInfo.endCursor;
    }
    throw new Error(`GitHub search returned more than ${maxPages} pages; refusing a partial sync`);
  }
}

function toExternal(node: PrNode, reasons: Set<PrReason>): ExternalItem {
  return {
    externalId: node.id!,
    type: 'pr',
    title: node.title,
    link: node.url,
    meta: {
      repo: node.repository.nameWithOwner,
      number: node.number,
      author: node.author?.login ?? null,
      draft: node.isDraft,
      reviewDecision: node.reviewDecision,
      reasons: REASON_ORDER.filter((r) => reasons.has(r)),
      prCreatedAt: node.createdAt,
      prUpdatedAt: node.updatedAt,
    },
  };
}
