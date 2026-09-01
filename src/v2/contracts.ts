import { z } from 'zod';
import { canonicalHash, canonicalJson, sha256Hex, type JsonValue } from '../contracts/canonical.js';
import { CostEvidenceSchema } from '../contracts/schemas.js';

const nonEmpty = z.string().trim().min(1);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitObject = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const timestamp = z.string().datetime({ offset: true });
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(jsonValue),
]));

export const V2_SCHEMA_VERSIONS = Object.freeze({
  case: 'yylo_benchmark_case.v2',
  attemptPlan: 'yylo_benchmark_attempt_plan.v2',
  attemptEvidence: 'yylo_benchmark_attempt_evidence.v2',
  evaluationRecord: 'yylo_benchmark_evaluation_record.v2',
  report: 'yylo_benchmark_report.v2',
  reportProvenance: 'yylo_benchmark_report_provenance.v2',
} as const);

export const SourceIdentityV2Schema = z.object({
  repository: nonEmpty,
  commit: gitObject,
  tree: gitObject,
  candidate_manifest_hash: hash,
}).strict();

export const UnifiedCaseV2Schema = z.object({
  schema_version: z.literal(V2_SCHEMA_VERSIONS.case),
  yylo_version: nonEmpty,
  case_id: nonEmpty,
  kind: z.enum(['task', 'workflow', 'custom']),
  case_version: nonEmpty,
  normalized_input: jsonValue,
  normalized_input_hash: hash,
  source: SourceIdentityV2Schema,
}).strict().superRefine((value, context) => {
  if (canonicalHash(value.normalized_input) !== value.normalized_input_hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['normalized_input_hash'], message: 'normalized input hash is invalid' });
  }
});

export const HarnessIdentityV2Schema = z.object({
  harness_profile: nonEmpty,
  requested_model: nonEmpty,
  resolved_provider: nonEmpty.nullable(),
  resolved_model: nonEmpty.nullable(),
  observed_provider: nonEmpty.nullable(),
  observed_model: nonEmpty.nullable(),
  observed_harness_version: nonEmpty.nullable(),
}).strict();

export const EvaluatorProfileRefV2Schema = z.object({
  profile_id: nonEmpty,
  profile_version: nonEmpty,
  generation: z.number().int().positive().default(1),
  kind: z.enum(['deterministic', 'llm_judge', 'imported', 'human']),
  required: z.boolean(),
  config_hash: hash,
}).strict();

export const AttemptPlanV2Schema = z.object({
  schema_version: z.literal(V2_SCHEMA_VERSIONS.attemptPlan),
  yylo_version: nonEmpty,
  benchmark_version: nonEmpty,
  attempt_id: hash,
  plan_hash: hash,
  experiment_id: nonEmpty,
  attempt_index: z.number().int().positive(),
  case: UnifiedCaseV2Schema,
  harness_profile: nonEmpty,
  requested_model: nonEmpty,
  workspace_backend: z.enum(['fresh_repository', 'linked_worktree', 'container', 'remote_worker']),
  variables: z.record(jsonValue),
  resources: z.array(z.object({ type: nonEmpty, id: nonEmpty, access: z.enum(['read', 'write', 'exclusive']) }).strict()),
  evaluators: z.array(EvaluatorProfileRefV2Schema),
  comparison_kind: z.enum(['model_only', 'agent_system']),
}).strict();

export const AttemptEvidenceV2Schema = z.object({
  schema_version: z.literal(V2_SCHEMA_VERSIONS.attemptEvidence),
  yylo_version: nonEmpty,
  benchmark_version: nonEmpty,
  attempt_id: hash,
  plan_hash: hash,
  candidate: z.object({
    status: z.enum(['success', 'failure', 'timeout', 'cancelled', 'invalid']),
    exit_code: z.number().int().nullable(), signal: nonEmpty.nullable(), session_id: nonEmpty.nullable(),
    started_at: timestamp, ended_at: timestamp, runtime_ms: z.number().int().nonnegative(), cost: CostEvidenceSchema,
    output: z.string().max(1024 * 1024).nullable().default(null),
    validity: z.enum(['valid', 'invalid']).default('valid'),
    diagnostics: z.array(z.object({ code: nonEmpty, message: nonEmpty }).strict()).default([]),
  }).strict(),
  identity: HarnessIdentityV2Schema,
  workspace_receipt_hash: hash,
  workspace_manifest_hash: hash,
  artifacts: z.array(z.object({ role: nonEmpty, sha256: hash, size: z.number().int().nonnegative() }).strict()),
  evidence_hash: hash,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.candidate.ended_at) < Date.parse(value.candidate.started_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['candidate', 'ended_at'], message: 'candidate ended before it started' });
  }
});

export const EvaluationRecordV2Schema = z.object({
  schema_version: z.literal(V2_SCHEMA_VERSIONS.evaluationRecord),
  yylo_version: nonEmpty,
  evaluation_id: hash,
  attempt_id: hash,
  evidence_hash: hash,
  evaluator_profile_id: nonEmpty,
  evaluator_generation: z.number().int().positive(),
  evaluator_kind: z.enum(['deterministic', 'llm_judge', 'imported', 'human']),
  validity: z.enum(['valid', 'invalid']),
  quality: z.enum(['resolved', 'unresolved', 'unknown']),
  required_gate: z.boolean(),
  findings: z.array(z.object({ code: nonEmpty, message: nonEmpty, severity: z.enum(['info', 'warning', 'error']) }).strict()),
  cost: CostEvidenceSchema,
  runtime_ms: z.number().int().nonnegative(),
  provenance_hash: hash,
  profile_hash: hash.optional(),
  prompt_hash: hash.nullable().optional(),
  rubric_hash: hash.nullable().optional(),
  raw_output: z.string().max(1024 * 1024).optional(),
  raw_output_hash: hash.optional(),
  evaluator_session_ids: z.array(nonEmpty).default([]),
  evaluator_identity: HarnessIdentityV2Schema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.validity === 'invalid' && value.quality !== 'unknown') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['quality'], message: 'invalid evaluation quality must be unknown' });
  }
});

const RuntimeAggregateV2Schema = z.object({
  count: z.number().int().nonnegative(), total_ms: z.number().int().nonnegative(), min_ms: z.number().int().nonnegative().nullable(),
  max_ms: z.number().int().nonnegative().nullable(), mean_ms: z.number().nonnegative().finite().nullable(),
}).strict();

export const ReportRuntimeV2Schema = z.object({
  unit: z.literal('milliseconds'), provenance: z.literal('measured_wall_clock'),
  attempts: z.array(z.object({ attempt_id: hash, evidence_hash: hash, runtime_ms: z.number().int().nonnegative(), started_at: timestamp, ended_at: timestamp }).strict()),
  evaluators: z.array(z.object({ evaluation_id: hash, attempt_id: hash, evaluator_profile_id: nonEmpty,
    evaluator_generation: z.number().int().positive(), runtime_ms: z.number().int().nonnegative() }).strict()),
  aggregate: z.object({ candidate: RuntimeAggregateV2Schema, evaluators: RuntimeAggregateV2Schema, total_ms: z.number().int().nonnegative() }).strict(),
}).strict();

export const ReportProvenanceV2Schema = z.object({
  schema_version: z.literal(V2_SCHEMA_VERSIONS.reportProvenance),
  yylo_version: nonEmpty,
  report_id: hash,
  attempt_evidence_ids: z.array(hash),
  evaluation_ids: z.array(hash),
  evaluator_generations: z.array(z.object({ profile_id: nonEmpty, generation: z.number().int().positive() }).strict()),
  derived_at: timestamp,
}).strict();

export const ReportV2Schema = z.object({
  schema_version: z.literal(V2_SCHEMA_VERSIONS.report), yylo_version: nonEmpty, plan_hash: hash,
  comparison_kind: z.enum(['model_only', 'agent_system']), evidence_count: z.number().int().nonnegative(),
  valid_resolved: z.number().int().nonnegative(), valid_unresolved: z.number().int().nonnegative(), invalid: z.number().int().nonnegative(),
  unknown_quality: z.number().int().nonnegative(), candidate_cost: CostEvidenceSchema, judge_cost: CostEvidenceSchema,
  runtime: ReportRuntimeV2Schema,
  evaluator_generations: z.array(z.object({ profile_id: nonEmpty, generation: z.number().int().positive() }).strict()),
  provenance: ReportProvenanceV2Schema,
}).strict();

export type UnifiedCaseV2 = z.infer<typeof UnifiedCaseV2Schema>;
export type AttemptPlanV2 = z.infer<typeof AttemptPlanV2Schema>;
export type AttemptEvidenceV2 = z.infer<typeof AttemptEvidenceV2Schema>;
export type EvaluationRecordV2 = z.infer<typeof EvaluationRecordV2Schema>;

export function normalizeCase(input: {
  readonly kind: UnifiedCaseV2['kind']; readonly case_id: string; readonly case_version: string;
  readonly input: JsonValue; readonly source: z.input<typeof SourceIdentityV2Schema>; readonly yylo_version?: string;
}): UnifiedCaseV2 {
  return UnifiedCaseV2Schema.parse({ schema_version: V2_SCHEMA_VERSIONS.case, yylo_version: input.yylo_version ?? 'unavailable', case_id: input.case_id, kind: input.kind,
    case_version: input.case_version, normalized_input: input.input, normalized_input_hash: canonicalHash(input.input), source: input.source });
}

export function createAttemptPlan(input: {
  readonly case: UnifiedCaseV2; readonly experiment_id: string; readonly attempt_index: number;
  readonly harness_profile: string; readonly requested_model: string; readonly workspace_backend: AttemptPlanV2['workspace_backend'];
  readonly evaluators: readonly z.input<typeof EvaluatorProfileRefV2Schema>[]; readonly yylo_version: string; readonly benchmark_version: string;
  readonly variables?: Readonly<Record<string, JsonValue>>; readonly resources?: readonly { readonly type: string; readonly id: string; readonly access: 'read' | 'write' | 'exclusive' }[];
  readonly comparison_kind?: AttemptPlanV2['comparison_kind'];
}): AttemptPlanV2 {
  const attemptId = canonicalHash({ experiment_id: input.experiment_id, case_hash: input.case.normalized_input_hash, attempt_index: input.attempt_index,
    harness_profile: input.harness_profile, requested_model: input.requested_model });
  const core = { schema_version: V2_SCHEMA_VERSIONS.attemptPlan, yylo_version: input.yylo_version, benchmark_version: input.benchmark_version,
    attempt_id: attemptId, experiment_id: input.experiment_id, attempt_index: input.attempt_index, case: input.case,
    harness_profile: input.harness_profile, requested_model: input.requested_model, workspace_backend: input.workspace_backend,
    variables: input.variables ?? {}, resources: input.resources ?? [], evaluators: input.evaluators,
    comparison_kind: input.comparison_kind ?? 'model_only' } as const;
  return AttemptPlanV2Schema.parse({ ...core, plan_hash: canonicalHash(core) });
}

export function serializeV2(value: unknown): string {
  const serialized = canonicalJson(value);
  if (serialized.includes('juno_version')) throw new Error('v2 durable output contains obsolete juno_version branding');
  return serialized;
}

const LEGACY_SCHEMAS = new Set([
  'juno_benchmark_attempt.v1',
  'juno_benchmark_workflow_evidence_receipt.v2',
  'juno_benchmark_workflow_evidence_receipt.v3',
  'juno_execution_envelope.v1',
]);

function projectLegacyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectLegacyValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const projectedKey = key === 'juno_version' ? 'yylo_version'
      : key === 'requested_juno_version' ? 'requested_yylo_version'
        : key === 'observed_juno_version' ? 'observed_yylo_version' : key;
    return [projectedKey, projectLegacyValue(item)];
  }));
}

export function projectLegacyEvidence(bytes: Uint8Array, expectedHash: `sha256:${string}`): {
  readonly source_hash: `sha256:${string}`; readonly source_schema_version: string; readonly read_only: true; readonly projection: Record<string, unknown>;
} {
  const source = Buffer.from(bytes); const actual = `sha256:${sha256Hex(source)}` as const;
  if (actual !== expectedHash) throw new Error('legacy evidence hash verification failed');
  let parsed: unknown;
  try { parsed = JSON.parse(source.toString('utf8')) as unknown; } catch { throw new Error('legacy evidence is not valid JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('legacy evidence must be an object');
  const schema = (parsed as Record<string, unknown>)['schema_version'];
  if (typeof schema !== 'string' || !LEGACY_SCHEMAS.has(schema)) throw new Error(`unsupported legacy evidence schema: ${String(schema)}`);
  const projection = projectLegacyValue(parsed) as Record<string, unknown>;
  return Object.freeze({ source_hash: actual, source_schema_version: schema, read_only: true, projection: Object.freeze(projection) });
}
