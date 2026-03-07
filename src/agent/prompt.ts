import { Liquid } from 'liquidjs';
import { Issue, WorkflowError } from '../domain';

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): Promise<string> {
  if (!template.trim()) {
    return 'You are working on an issue from Linear.';
  }

  const context: Record<string, unknown> = {
    issue: issueToTemplateVars(issue),
    attempt: attempt ?? null,
  };

  let tpl: ReturnType<typeof engine.parse>;
  try {
    tpl = engine.parse(template);
  } catch (err) {
    throw new WorkflowError('template_parse_error', `Template parse error: ${(err as Error).message}`);
  }

  try {
    return await engine.render(tpl, context);
  } catch (err) {
    throw new WorkflowError('template_render_error', `Template render error: ${(err as Error).message}`);
  }
}

function issueToTemplateVars(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name,
    url: issue.url,
    labels: issue.labels,
    blocked_by: issue.blocked_by.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.created_at?.toISOString() ?? null,
    updated_at: issue.updated_at?.toISOString() ?? null,
  };
}
