import { Issue } from '../domain';

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Array<{ id: string; state: string }>>;
  fetchStateIdByName(name: string): Promise<string | null>;
  updateIssue(issueId: string, updates: { stateId?: string }): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
}
