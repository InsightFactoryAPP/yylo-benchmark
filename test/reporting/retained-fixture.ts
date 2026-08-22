import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalHash, canonicalJson } from '../../src/contracts/canonical.js';
import { AttemptV1Schema, NormalizedResultV1Schema } from '../../src/contracts/schemas.js';
import type { PublicKanbanClient, BenchmarkRecordInput, CanonicalRecord, RevisionedTask } from '../../src/kanban/client.js';
import type { ExecutionPlan } from '../../src/planning/index.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';

const h = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;
export async function retainedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-retained-')); const registry = new ImmutableArtifactRegistry(path.join(root, 'registry'));
  const revision = '1'.repeat(64); const experimentRecords: RevisionedTask[] = []; const investigations: CanonicalRecord[] = []; let candidateInvocations = 0;
  const sourceTask = { id: 'CASE1', status: 'done', body: 'Fix it.', last_modified: '2026-08-12T00:00:00Z', commit_hash: 'b'.repeat(40), feature_tags: ['benchmark-case'], related_tasks: [], blocked_by: [], fields: {} };
  const memory = {
    async getRevisionedTask(taskId: string): Promise<RevisionedTask> {
      if (taskId === 'CASE1') return { task: sourceTask, revision } as RevisionedTask;
      const found = [...experimentRecords, ...investigations.map((item) => ({ task: item.task, revision: item.receipt.after_sha256 }))].find((item) => item.task.id === taskId);
      if (found === undefined) throw new Error(`missing task ${taskId}`); return found;
    },
    async listRelatedRecords(kind: BenchmarkRecordInput['kind']): Promise<readonly RevisionedTask[]> { return kind === 'experiment' ? experimentRecords : investigations.map((item) => ({ task: item.task, revision: item.receipt.after_sha256 })); },
    async findRelatedRecord(input: Pick<BenchmarkRecordInput, 'kind' | 'recordId'>): Promise<RevisionedTask | null> {
      const records = input.kind === 'experiment' ? experimentRecords : investigations.map((item) => ({ task: item.task, revision: item.receipt.after_sha256 }));
      return records.find((item) => (item.task.fields['benchmark'] as { record_id?: unknown }).record_id === input.recordId) ?? null;
    },
    async createRelatedRecord(input: BenchmarkRecordInput): Promise<CanonicalRecord> {
      const id = `INV${investigations.length + 1}`; const after = `${investigations.length + 2}`.repeat(64).slice(0, 64);
      const task = { id, status: 'backlog', body: input.title ?? '', last_modified: '2026-08-12T00:00:00Z', commit_hash: null, feature_tags: ['benchmark-investigation'], related_tasks: [input.sourceTaskId], blocked_by: [], fields: { benchmark: input.benchmark } };
      const record = { task, receipt: { task_id: id, operation: 'create', before_sha256: null, after_sha256: after, ledger_event_id: `event-${id}`, changed_paths: ['/'], persisted_path: `tasks/${id}.md` } } as CanonicalRecord;
      investigations.push(record); return record;
    },
  };
  const client = memory as unknown as PublicKanbanClient;

  async function addAttempt(options: { model: string; budget?: `sha256:${string}`; resolved?: boolean; cost?: { completeness: 'complete'; usd: number } | { completeness: 'unavailable'; usd: null }; patch?: string }): Promise<ExecutionPlan> {
    const model = options.model; const resolved = options.resolved ?? true; const cost = options.cost ?? { completeness: 'complete' as const, usd: 1 };
    const caseValue = { schema_version: 'juno_benchmark_eval_case.v1' as const, task_id: 'CASE1', task_revision: revision, task_hash: h('a'), prompt_hash: h('b'), case_ref: { schema_version: 'juno_benchmark_case_ref.v1' as const, eligible: true as const, case_version: 1, repository_id: 'root', base_commit: 'a'.repeat(40), category: 'backend', grader_profile: 'focused-tests', wiki_paths: [] }, input_hash: h('c') };
    const core = { schema_version: 'juno_benchmark_plan.v1' as const, case: caseValue, models: [model], model_selectors: { [model]: model }, attempts: 1, snapshot_hash: h('2'), wiki_hashes: {}, tool_policy_hash: h('3'), budget_hash: options.budget ?? h('4'), package_version: '0.1.0', juno_version: '2.0.0', isolation: { git_objects: 'isolated' as const, host_filesystem: 'trusted' as const, container: 'none' as const } };
    const plan: ExecutionPlan = { ...core, plan_id: canonicalHash(core) }; const experimentKey = plan.plan_id.slice(7); const attemptId = canonicalHash({ plan: plan.plan_id, model }).slice(7);
    const contract = AttemptV1Schema.parse({ schema_version: 'juno_benchmark_attempt.v1', attempt_id: attemptId, experiment_id: plan.plan_id, case_input_hash: caseValue.input_hash, snapshot_hash: plan.snapshot_hash, prompt_hash: caseValue.prompt_hash, agent: 'yylo', provider: 'configured', model, tool_policy_hash: plan.tool_policy_hash, budget_hash: plan.budget_hash, package_version: plan.package_version, juno_version: plan.juno_version, session_topology: 'fresh' });
    const patch = await registry.put('patch', options.patch ?? 'diff --git a/file b/file\n+owner@example.com token=supersecretvalue\n');
    const terminal = { schema_version: 'juno_benchmark_juno_terminal_evidence.v1', attempt_id: attemptId, agent: 'yylo', provider: 'fake', model, juno_version: '2.0.0', session_id: `S-${model}`, exit_code: resolved ? 0 : 1, signal: null, payload: {}, stderr_present: false };
    const result = NormalizedResultV1Schema.parse({ schema_version: 'juno_benchmark_normalized_result.v1', attempt_id: attemptId, resolved, terminal_class: resolved ? 'resolved' : 'model_failure', session_id: `S-${model}`, started_at: '2026-08-12T00:00:00.000Z', ended_at: '2026-08-12T00:00:01.000Z', elapsed_ms: model === ':mini' ? 1000 : 2000, cost, patch_hash: patch.sha256, terminal_evidence_hash: canonicalHash(terminal) });
    for (const [role, value] of [['execution-plan', plan], ['attempt-contract', contract], ['structured-juno-evidence', terminal], ['normalized-result', result]] as const) {
      const reference = await registry.put(role, role === 'structured-juno-evidence' ? canonicalJson(value) : `${canonicalJson(value)}\n`); await registry.append(experimentKey, reference);
    }
    await registry.append(experimentKey, patch);
    const task = { id: `EXP${experimentRecords.length + 1}`, status: 'done', body: '', last_modified: '2026-08-12T00:00:00Z', commit_hash: null, feature_tags: ['benchmark-experiment'], related_tasks: ['CASE1'], blocked_by: [], fields: { benchmark: { experiment_id: plan.plan_id, source_task_id: 'CASE1', record_id: plan.plan_id } } };
    experimentRecords.push({ task, revision: 'e'.repeat(64) } as RevisionedTask); return plan;
  }
  return { root, registry, client, addAttempt, investigations, candidateInvocations: () => candidateInvocations, recordCandidateInvocation: () => { candidateInvocations += 1; } };
}
