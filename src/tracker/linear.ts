import { Issue, TrackerConfig, TrackerError } from '../domain';
import { TrackerClient } from './client';
import { logger } from '../observability/logger';

const NETWORK_TIMEOUT_MS = 30000;
const PAGE_SIZE = 50;

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

async function gqlRequest(
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new TrackerError('linear_api_request', `Network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    logger.debug({ status: res.status, body: detail.slice(0, 500) }, `linear api HTTP error status=${res.status}`);
    throw new TrackerError('linear_api_status', `HTTP ${res.status} from Linear API: ${detail.slice(0, 200)}`);
  }

  let body: GraphQLResponse;
  try {
    body = (await res.json()) as GraphQLResponse;
  } catch {
    throw new TrackerError('linear_unknown_payload', 'Non-JSON response from Linear');
  }

  if (body.errors && body.errors.length > 0) {
    throw new TrackerError('linear_graphql_errors', body.errors.map((e) => e.message).join('; '));
  }

  if (!body.data) {
    throw new TrackerError('linear_unknown_payload', 'Missing data field in response');
  }

  return body.data;
}

const CANDIDATE_ISSUES_QUERY = `
  query CandidateIssues($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: ${PAGE_SIZE}
      after: $after
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        url
        branchName
        createdAt
        updatedAt
        state { name }
        labels { nodes { name } }
        relations {
          nodes {
            type
            relatedIssue {
              id
              identifier
              state { name }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUES_BY_STATES_QUERY = `
  query IssuesByStates($projectSlug: String!, $states: [String!]!) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: 250
    ) {
      nodes {
        id
        identifier
        state { name }
      }
    }
  }
`;

const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }, first: 250) {
      nodes {
        id
        identifier
        state { name }
      }
    }
  }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeIssue(node: any): Issue {
  const priority = Number.isInteger(node.priority) ? (node.priority as number) : null;
  const labels: string[] = (node.labels?.nodes ?? []).map((l: { name: string }) =>
    l.name.toLowerCase(),
  );

  // "blocked_by": Linear represents blockers as relations with type="blocked_by" on the blocked issue.
  const blocked_by: Array<{ id: string | null; identifier: string | null; state: string | null }> = [];
  for (const r of (node.relations?.nodes ?? [])) {
    if (r.type === 'blocked_by') {
      blocked_by.push({
        id: r.relatedIssue?.id ?? null,
        identifier: r.relatedIssue?.identifier ?? null,
        state: r.relatedIssue?.state?.name ?? null,
      });
    }
  }

  return {
    id: String(node.id),
    identifier: String(node.identifier),
    title: String(node.title ?? ''),
    description: node.description != null ? String(node.description) : null,
    priority: priority !== 0 ? priority : null, // Linear uses 0 for "no priority"
    state: String(node.state?.name ?? ''),
    branch_name: node.branchName != null ? String(node.branchName) : null,
    url: node.url != null ? String(node.url) : null,
    labels,
    blocked_by,
    created_at: node.createdAt ? new Date(node.createdAt as string) : null,
    updated_at: node.updatedAt ? new Date(node.updatedAt as string) : null,
  };
}

export class LinearClient implements TrackerClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string;
  private readonly activeStates: string[];
  private readonly terminalStates: string[];

  constructor(config: TrackerConfig) {
    this.endpoint = config.endpoint;
    this.apiKey = config.api_key;
    this.projectSlug = config.project_slug;
    this.activeStates = config.active_states;
    this.terminalStates = config.terminal_states;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;

    for (;;) {
      const data = await gqlRequest(this.endpoint, this.apiKey, CANDIDATE_ISSUES_QUERY, {
        projectSlug: this.projectSlug,
        states: this.activeStates,
        after,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issuesData = (data as any).issues;
      if (!issuesData || !Array.isArray(issuesData.nodes)) {
        throw new TrackerError('linear_unknown_payload', 'Unexpected issues payload shape');
      }

      for (const node of issuesData.nodes) {
        try {
          issues.push(normalizeIssue(node));
        } catch (err) {
          logger.warn({ err }, 'Failed to normalize issue node, skipping');
        }
      }

      if (!issuesData.pageInfo?.hasNextPage) break;
      after = issuesData.pageInfo?.endCursor ?? null;
      if (!after) {
        throw new TrackerError('linear_missing_end_cursor', 'hasNextPage=true but endCursor is missing');
      }
    }

    return issues;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const data = await gqlRequest(this.endpoint, this.apiKey, ISSUES_BY_STATES_QUERY, {
      projectSlug: this.projectSlug,
      states: stateNames,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issuesData = (data as any).issues;
    if (!issuesData || !Array.isArray(issuesData.nodes)) {
      throw new TrackerError('linear_unknown_payload', 'Unexpected issues payload shape');
    }

    return issuesData.nodes.map(normalizeIssue);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Array<{ id: string; state: string }>> {
    if (issueIds.length === 0) return [];

    const data = await gqlRequest(this.endpoint, this.apiKey, ISSUE_STATES_BY_IDS_QUERY, {
      ids: issueIds,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issuesData = (data as any).issues;
    if (!issuesData || !Array.isArray(issuesData.nodes)) {
      throw new TrackerError('linear_unknown_payload', 'Unexpected issues payload shape');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return issuesData.nodes.map((n: any) => ({
      id: String(n.id),
      state: String(n.state?.name ?? ''),
    }));
  }

  getTerminalStates(): string[] {
    return this.terminalStates;
  }
}
