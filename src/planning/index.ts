import { canonicalHash, canonicalJson } from '../contracts/canonical.js';
import { EvalCaseV1Schema, type EvalCaseV1 } from '../contracts/schemas.js';
import { lintBenchmarkCase } from '../case/lint.js';
import { PublicKanbanClient, type CanonicalRecord } from '../kanban/client.js';
import { ImmutableArtifactRegistry, type ArtifactReference } from '../registry/index.js';
import { z } from 'zod';
import { WorkflowExecutionPlanObjectSchema, WorkflowExecutionPlanSchema, type WorkflowExecutionPlan } from '../workflow/plan.js';

export const PLAN_SCHEMA_VERSION = 'juno_benchmark_plan.v1' as const;
export const DEFAULT_TASK_AGGREGATE_MAX_USD = 20;
export interface PlanInputs {
  readonly taskId: string;
  /** Exact provider/model identities. Alias selectors must be resolved before planning. */
  readonly models: readonly string[];
  readonly modelSelectors?: Readonly<Record<string, string>>;
  readonly attempts: number;
  readonly snapshotHash: `sha256:${string}`;
  readonly wikiHashes: Readonly<Record<string, `sha256:${string}`>>;
  readonly toolPolicyHash: `sha256:${string}`;
  readonly budgetHash: `sha256:${string}`;
  readonly packageVersion: string;
  readonly junoVersion: string;
  readonly aggregateMaxUsd?: number;
}
export interface ExecutionPlan {
  readonly schema_version: typeof PLAN_SCHEMA_VERSION;
  readonly plan_id: `sha256:${string}`;
  readonly case: EvalCaseV1;
  /** Exact provider/model identities dispatched to Juno Code. */
  readonly models: readonly string[];
  /** Exact model identity -> user selector, retained in the immutable plan. */
  readonly model_selectors: Readonly<Record<string, string>>;
  readonly attempts: number;
  readonly snapshot_hash: `sha256:${string}`;
  readonly wiki_hashes: Readonly<Record<string, `sha256:${string}`>>;
  readonly tool_policy_hash: `sha256:${string}`;
  readonly budget_hash: `sha256:${string}`;
  readonly package_version: string;
  readonly juno_version: string;
  readonly spend_limits: { readonly currency: 'USD'; readonly aggregate_max_usd: number; readonly per_attempt_max_usd: number };
  readonly isolation: { readonly git_objects: 'isolated'; readonly host_filesystem: 'trusted'; readonly container: 'none' };
}
const planHash = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const TaskExecutionPlanSchema = z.object({
  schema_version: z.literal(PLAN_SCHEMA_VERSION), plan_id: planHash, case: EvalCaseV1Schema,
  models: z.array(z.string().regex(/^[^:/\s]+\/[^:/\s]+$/u)).min(1), model_selectors: z.record(z.string().trim().min(1)),
  attempts: z.number().int().positive(), snapshot_hash: planHash, wiki_hashes: z.record(planHash),
  tool_policy_hash: planHash, budget_hash: planHash, package_version: z.string().trim().min(1), juno_version: z.string().trim().min(1),
  spend_limits: z.object({ currency: z.literal('USD'), aggregate_max_usd: z.number().finite().positive(), per_attempt_max_usd: z.number().finite().positive() }).strict(),
  isolation: z.object({ git_objects: z.literal('isolated'), host_filesystem: z.literal('trusted'), container: z.literal('none') }).strict(),
}).strict();
export const TaskExecutionAuthorizationSchema = z.object({
  schema_version: z.literal('juno_benchmark_task_authorization.v1'), plan_id: planHash,
  authorization_id: z.string().trim().min(1), models: z.array(z.string().regex(/^[^:/\s]+\/[^:/\s]+$/u)).min(1),
  expires_at: z.string().datetime({ offset: true }), currency: z.literal('USD'),
  aggregate_max_usd: z.number().finite().positive(), per_attempt_max_usd: z.number().finite().positive(),
}).strict();
export type TaskExecutionAuthorization = z.infer<typeof TaskExecutionAuthorizationSchema>;
/** The schema_version is the durable plan-kind discriminator; task plans bind spend limits into their hash. */
export const BenchmarkPlanSchema = z.discriminatedUnion('schema_version', [TaskExecutionPlanSchema, WorkflowExecutionPlanObjectSchema]);
export type BenchmarkPlan = ExecutionPlan | WorkflowExecutionPlan;
export function parseBenchmarkPlan(value: unknown): BenchmarkPlan {
  const discriminated = BenchmarkPlanSchema.parse(value);
  const plan = discriminated.schema_version === 'juno_benchmark_workflow_plan.v1'
    ? WorkflowExecutionPlanSchema.parse(discriminated) : discriminated as BenchmarkPlan;
  const { plan_id: claimed, ...core } = plan;
  if (claimed !== canonicalHash(core)) throw new Error('execution plan hash is invalid');
  return plan;
}

export type RecordPolicy = { readonly noRecord?: false } | { readonly noRecord: true; readonly nonCanonicalScope: 'fixture' | 'local' };
export interface AcceptedPlan {
  readonly canonical: boolean;
  readonly plan: ExecutionPlan;
  readonly planReference: ArtifactReference;
  readonly record: CanonicalRecord | null;
  readonly recovered: boolean;
}

function hash(value: string, label: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`invalid ${label}`);
}
export function validatePlanModelBindings(plan: Pick<ExecutionPlan, 'models' | 'model_selectors'>): void {
  if (plan.models.length === 0 || plan.models.some((model) => !/^[^:/\s]+\/[^:/\s]+$/u.test(model))) {
    throw new Error('execution plan models must be exact provider/model identities');
  }
  if (new Set(plan.models).size !== plan.models.length) throw new Error('execution plan models must be unique');
  const bindings = plan.model_selectors;
  if (typeof bindings !== 'object' || bindings === null || Object.keys(bindings).length !== plan.models.length) throw new Error('execution plan model selector bindings are incomplete');
  for (const model of plan.models) {
    const selector = bindings[model];
    if (typeof selector !== 'string' || selector.trim() === '') throw new Error(`execution plan has no selector binding for ${model}`);
  }
  if (Object.keys(bindings).some((model) => !plan.models.includes(model))) throw new Error('execution plan has an unplanned model selector binding');
}

function exactCase(task: ReturnType<typeof lintBenchmarkCase>, revision: string): EvalCaseV1 {
  const core = { ...task, task_revision: revision };
  return EvalCaseV1Schema.parse({ ...core, input_hash: canonicalHash({
    task_id: core.task_id, task_revision: revision, task_hash: core.task_hash,
    prompt_hash: core.prompt_hash, case_ref: core.case_ref,
  }) });
}

/** Read-only deterministic planning. It performs no Kanban or registry mutation. */
export async function planExperiment(client: PublicKanbanClient, input: PlanInputs): Promise<ExecutionPlan> {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) throw new Error('attempts must be a positive safe integer');
  if (input.models.length === 0 || input.models.some((model) => model.trim() === '')) throw new Error('at least one non-empty model is required');
  if (input.models.some((model) => !/^[^:/\s]+\/[^:/\s]+$/u.test(model))) {
    throw new Error('models must be exact provider/model identities; resolve aliases before planning');
  }
  const models = [...new Set(input.models.map((model) => model.trim()))].sort();
  if (models.length !== input.models.length) throw new Error('models must be unique');
  const selectors = Object.fromEntries(models.map((model) => [model, input.modelSelectors?.[model] ?? model]));
  if (Object.keys(input.modelSelectors ?? {}).some((model) => !models.includes(model))) throw new Error('model selector binding has no planned exact model');
  hash(input.snapshotHash, 'snapshot hash'); hash(input.toolPolicyHash, 'tool-policy hash'); hash(input.budgetHash, 'budget hash');
  for (const [wikiPath, wikiHash] of Object.entries(input.wikiHashes)) { if (wikiPath.trim() === '') throw new Error('empty wiki path'); hash(wikiHash, 'wiki hash'); }
  const aggregateMaxUsd = input.aggregateMaxUsd ?? DEFAULT_TASK_AGGREGATE_MAX_USD;
  if (!Number.isFinite(aggregateMaxUsd) || aggregateMaxUsd <= 0) throw new Error('aggregate max USD must be a positive finite number');
  const dispatchCount = models.length * input.attempts;
  const perAttemptMaxUsd = Math.floor((aggregateMaxUsd * 1_000_000) / dispatchCount) / 1_000_000;
  if (perAttemptMaxUsd <= 0) throw new Error('aggregate max USD is too small for the planned task attempts');
  const source = await client.getRevisionedTask(input.taskId);
  const benchmarkCase = exactCase(lintBenchmarkCase(source.task), source.revision);
  const core = {
    schema_version: PLAN_SCHEMA_VERSION, case: benchmarkCase, models, model_selectors: selectors, attempts: input.attempts,
    snapshot_hash: input.snapshotHash, wiki_hashes: Object.fromEntries(Object.entries(input.wikiHashes).sort(([a], [b]) => a.localeCompare(b))),
    tool_policy_hash: input.toolPolicyHash, budget_hash: input.budgetHash,
    package_version: input.packageVersion, juno_version: input.junoVersion,
    spend_limits: { currency: 'USD' as const, aggregate_max_usd: aggregateMaxUsd, per_attempt_max_usd: perAttemptMaxUsd },
    isolation: { git_objects: 'isolated', host_filesystem: 'trusted', container: 'none' } as const,
  };
  return Object.freeze({ ...core, plan_id: canonicalHash(core) });
}

export async function acceptPlan(client: PublicKanbanClient, registry: ImmutableArtifactRegistry, plan: ExecutionPlan, policy: RecordPolicy = {}): Promise<AcceptedPlan> {
  const { plan_id: claimedPlanId, ...planCore } = plan;
  if (claimedPlanId !== canonicalHash(planCore)) throw new Error('execution plan hash is invalid');
  validatePlanModelBindings(plan);
  // Re-read exact source truth immediately before any canonical mutation.
  const source = await client.getRevisionedTask(plan.case.task_id);
  if (source.revision !== plan.case.task_revision) throw new Error(`stale benchmark case ${plan.case.task_id}: expected ${plan.case.task_revision}, current ${source.revision}`);
  const current = exactCase(lintBenchmarkCase(source.task), source.revision);
  if (current.input_hash !== plan.case.input_hash) throw new Error('benchmark case inputs no longer match the plan');
  if (policy.noRecord === true && policy.nonCanonicalScope !== 'fixture' && policy.nonCanonicalScope !== 'local') {
    throw new Error('--no-record requires explicit fixture or local non-canonical scope');
  }
  const planReference = await registry.put('execution-plan', `${canonicalJson(plan)}\n`);
  if (policy.noRecord === true) return { canonical: false, plan, planReference, record: null, recovered: false };

  const experimentKey = plan.plan_id.slice('sha256:'.length);
  const found = await client.findRelatedRecord({ kind: 'experiment', sourceTaskId: plan.case.task_id, recordId: plan.plan_id });
  if (found !== null) {
    const benchmark = found.task.fields['benchmark'] as { plan_hash?: unknown } | undefined;
    if (benchmark?.plan_hash !== plan.plan_id) throw new Error('recovered experiment record does not bind the exact plan');
    const retained = await registry.verifyExperiment(experimentKey);
    if (retained.length === 0) {
      const observation = await registry.put('kanban-recovery-observation', `${canonicalJson({ schema_version: 'juno_benchmark_kanban_recovery.v1', task_id: found.task.id, revision: found.revision, plan_hash: plan.plan_id })}\n`);
      await registry.append(experimentKey, planReference);
      await registry.append(experimentKey, observation);
      await registry.writeCaseIndex(plan.case.task_id, experimentKey, { task_id: found.task.id, plan_hash: plan.plan_id, evidence: [planReference.sha256, observation.sha256], recovered: true });
    }
    return { canonical: true, plan, planReference, record: null, recovered: true };
  }
  const benchmark = {
    schema_version: 'juno_benchmark_experiment_ref.v1', record_id: plan.plan_id,
    experiment_id: plan.plan_id, status: 'planned', source_task_id: plan.case.task_id,
    source_revision: plan.case.task_revision, source_task_hash: plan.case.task_hash,
    plan_hash: plan.plan_id, evidence: [planReference], requested_models: plan.models, attempts_per_model: plan.attempts,
  };
  const record = await client.createRelatedRecord({ kind: 'experiment', sourceTaskId: plan.case.task_id, sourceRevision: plan.case.task_revision, recordId: plan.plan_id, benchmark });
  const receipt = await registry.put('kanban-mutation-receipt', `${canonicalJson(record.receipt)}\n`);
  await registry.append(experimentKey, planReference);
  await registry.append(experimentKey, receipt);
  await registry.writeCaseIndex(plan.case.task_id, experimentKey, { task_id: record.task.id, plan_hash: plan.plan_id, evidence: [planReference.sha256, receipt.sha256] });
  return { canonical: true, plan, planReference, record, recovered: false };
}

export async function recordInvestigation(client: PublicKanbanClient, registry: ImmutableArtifactRegistry, input: {
  readonly plan: ExecutionPlan; readonly investigationId: string; readonly questionHash: `sha256:${string}`; readonly artifact: ArtifactReference;
}): Promise<CanonicalRecord> {
  hash(input.questionHash, 'question hash'); await registry.read(input.artifact);
  const source = await client.getRevisionedTask(input.plan.case.task_id);
  if (source.revision !== input.plan.case.task_revision) throw new Error('stale source revision for investigation');
  const benchmark = {
    schema_version: 'juno_benchmark_investigation_ref.v1', record_id: input.investigationId,
    investigation_id: input.investigationId, source_task_id: input.plan.case.task_id,
    source_revision: input.plan.case.task_revision, plan_hash: input.plan.plan_id,
    question_hash: input.questionHash, evidence: [input.artifact],
  };
  const record = await client.createRelatedRecord({ kind: 'investigation', sourceTaskId: input.plan.case.task_id, sourceRevision: input.plan.case.task_revision, recordId: input.investigationId, benchmark });
  const receipt = await registry.put('kanban-mutation-receipt', `${canonicalJson(record.receipt)}\n`);
  await registry.append(input.plan.plan_id.slice('sha256:'.length), input.artifact);
  await registry.append(input.plan.plan_id.slice('sha256:'.length), receipt);
  return record;
}
