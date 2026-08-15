import { z } from 'zod';
import { BenchmarkCaseRefV1Schema, EvalCaseV1Schema, SCHEMA_VERSIONS, type EvalCaseV1 } from '../contracts/schemas.js';
import { canonicalHash } from '../contracts/canonical.js';
import type { KanbanTask } from '../kanban/client.js';

const BenchmarkFieldsSchema = z.object({ benchmark: BenchmarkCaseRefV1Schema }).passthrough();

export class CaseLintError extends Error {
  public readonly issues: readonly string[];

  public constructor(taskId: string, issues: readonly string[]) {
    super(`task ${taskId} is not an eligible benchmark case: ${issues.join('; ')}`);
    this.name = 'CaseLintError';
    this.issues = issues;
  }
}

export function lintBenchmarkCase(task: KanbanTask): EvalCaseV1 {
  const issues: string[] = [];
  if (!task.feature_tags.includes('benchmark-case')) issues.push('missing benchmark-case tag');
  const fields = BenchmarkFieldsSchema.safeParse(task.fields);
  if (!fields.success) {
    issues.push(...fields.error.issues.map((issue) => {
      const location = issue.path.length === 0 ? 'fields' : `fields.${issue.path.join('.')}`;
      return `${location}: ${issue.message}`;
    }));
  }
  if (issues.length > 0 || !fields.success) throw new CaseLintError(task.id, issues);

  const caseRef = fields.data.benchmark;
  const taskIdentity = {
    id: task.id,
    status: task.status,
    body: task.body,
    last_modified: task.last_modified,
    commit_hash: task.commit_hash ?? null,
    feature_tags: [...task.feature_tags].sort(),
    related_tasks: [...task.related_tasks].sort(),
    blocked_by: [...task.blocked_by].sort(),
    fields: { benchmark: caseRef },
  };
  const taskHash = canonicalHash(taskIdentity);
  const promptHash = canonicalHash(task.body);
  const inputHash = canonicalHash({
    task_id: task.id,
    task_revision: task.last_modified,
    task_hash: taskHash,
    prompt_hash: promptHash,
    case_ref: caseRef,
  });
  return EvalCaseV1Schema.parse({
    schema_version: SCHEMA_VERSIONS.evalCase,
    task_id: task.id,
    task_revision: task.last_modified,
    task_hash: taskHash,
    prompt_hash: promptHash,
    case_ref: caseRef,
    input_hash: inputHash,
  });
}
