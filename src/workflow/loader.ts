import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { WorkflowDefinition, WorkflowError } from '../domain';

export function loadWorkflow(filePath: string): WorkflowDefinition {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new WorkflowError('missing_workflow_file', `Cannot read workflow file: ${filePath}`);
  }

  if (!content.startsWith('---')) {
    return { config: {}, prompt_template: content.trim() };
  }

  const secondDash = content.indexOf('---', 3);
  if (secondDash === -1) {
    throw new WorkflowError('workflow_parse_error', 'Unterminated YAML front matter');
  }

  const frontMatterText = content.slice(3, secondDash).trim();
  const bodyText = content.slice(secondDash + 3).trim();

  let parsed: unknown;
  try {
    parsed = yaml.load(frontMatterText);
  } catch (err) {
    throw new WorkflowError('workflow_parse_error', `YAML parse error: ${(err as Error).message}`);
  }

  if (parsed !== null && typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowError('workflow_front_matter_not_a_map', 'Front matter must be a YAML map/object');
  }

  const config = (parsed as Record<string, unknown>) ?? {};
  return { config, prompt_template: bodyText };
}
