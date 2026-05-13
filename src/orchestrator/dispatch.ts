import { Issue, OrchestratorState, ServiceConfig } from '../domain';

function normalizeState(s: string): string {
  return s.trim().toLowerCase();
}

function isActive(state: string, activeStates: string[], terminalStates: string[]): boolean {
  const norm = normalizeState(state);
  const active = activeStates.map(normalizeState);
  const terminal = terminalStates.map(normalizeState);
  return active.includes(norm) && !terminal.includes(norm);
}

export function isTerminal(state: string, terminalStates: string[]): boolean {
  return terminalStates.map(normalizeState).includes(normalizeState(state));
}

export function isEligible(
  issue: Issue,
  orchState: OrchestratorState,
  config: ServiceConfig,
  opts: { skipClaimedCheck?: boolean } = {},
): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

  const activeStates = config.tracker.linear.active_states;
  const terminalStates = config.tracker.linear.terminal_states;

  if (!isActive(issue.state, activeStates, terminalStates)) return false;
  if (orchState.running.has(issue.id)) return false;
  if (!opts.skipClaimedCheck && orchState.claimed.has(issue.id)) return false;

  const globalSlots = config.orchestrator.max_concurrent_agents - orchState.running.size;
  if (globalSlots <= 0) return false;

  // Blocker rule: if state is "todo", block if any blocker is non-terminal
  if (normalizeState(issue.state) === 'todo') {
    for (const blocker of issue.blocked_by) {
      if (blocker.state && !isTerminal(blocker.state, terminalStates)) return false;
    }
  }

  return true;
}

export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    // Priority ascending (null sorts last)
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;

    // Oldest first
    const ta = a.created_at?.getTime() ?? Infinity;
    const tb = b.created_at?.getTime() ?? Infinity;
    if (ta !== tb) return ta - tb;

    // Identifier lexicographic
    return a.identifier.localeCompare(b.identifier);
  });
}
