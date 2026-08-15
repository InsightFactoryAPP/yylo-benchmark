import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u, 'expected sha256:<lowercase hex>');
const fullGitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, 'expected a full Git object ID');
const utcTimestamp = z.string().datetime({ offset: true });
const relativeWikiPath = z.string().min(1).superRefine((value, context) => {
  if (value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'expected a normalized repository-relative path' });
  }
  if (!value.startsWith('juno-benchmark/project/')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'project wiki must be under juno-benchmark/project/' });
  }
});

export const SCHEMA_VERSIONS = Object.freeze({
  caseRef: 'juno_benchmark_case_ref.v1',
  evalCase: 'juno_benchmark_eval_case.v1',
  attempt: 'juno_benchmark_attempt.v1',
  graderResult: 'juno_benchmark_grader_result.v1',
  judgement: 'juno_benchmark_judgement.v1',
  normalizedResult: 'juno_benchmark_normalized_result.v1',
  executionEnvelope: 'juno_execution_envelope.v1',
  graderReceipt: 'juno_benchmark_grader_receipt.v1',
  releaseReadiness: 'juno_benchmark_release_readiness.v1',
} as const);

export const BenchmarkCaseRefV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.caseRef),
  eligible: z.literal(true),
  case_version: z.number().int().positive(),
  repository_id: nonEmpty,
  base_commit: fullGitObjectId,
  category: nonEmpty,
  grader_profile: nonEmpty,
  wiki_paths: z.array(relativeWikiPath).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.wiki_paths).size !== value.wiki_paths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['wiki_paths'], message: 'wiki paths must be unique' });
  }
});

export const EvalCaseV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.evalCase),
  task_id: nonEmpty,
  task_revision: nonEmpty,
  task_hash: sha256,
  prompt_hash: sha256,
  case_ref: BenchmarkCaseRefV1Schema,
  input_hash: sha256,
}).strict();

export const CostEvidenceSchema = z.discriminatedUnion('completeness', [
  z.object({ completeness: z.literal('complete'), usd: z.number().finite().nonnegative() }).strict(),
  z.object({ completeness: z.literal('partial'), usd: z.number().finite().nonnegative() }).strict(),
  z.object({ completeness: z.literal('unavailable'), usd: z.null() }).strict(),
  z.object({ completeness: z.literal('not_applicable'), usd: z.null() }).strict(),
]);

export const JunoExecutionEnvelopeV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.executionEnvelope),
  status: z.enum(['success', 'failure', 'timeout', 'cancelled']),
  session_id: nonEmpty.nullable(),
  provider: nonEmpty.nullable(),
  model: nonEmpty.nullable(),
  juno_version: nonEmpty,
  cost: CostEvidenceSchema,
}).strict();

export const AttemptV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.attempt),
  attempt_id: nonEmpty,
  experiment_id: nonEmpty,
  case_input_hash: sha256,
  snapshot_hash: sha256,
  prompt_hash: sha256,
  agent: nonEmpty,
  provider: nonEmpty,
  model: nonEmpty,
  tool_policy_hash: sha256,
  budget_hash: sha256,
  package_version: nonEmpty,
  juno_version: nonEmpty,
  session_topology: z.enum(['fresh', 'continued']),
}).strict();

export const GraderResultV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.graderResult),
  attempt_id: nonEmpty,
  grader_id: nonEmpty,
  grader_version: nonEmpty,
  required: z.boolean(),
  passed: z.boolean(),
  evidence_hash: sha256,
}).strict();

export const GraderReceiptV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.graderReceipt),
  attempt_id: nonEmpty,
  grader_profile: nonEmpty,
  grader_id: nonEmpty,
  grader_version: nonEmpty,
  required: z.literal(true),
  passed: z.boolean(),
  input_hash: sha256,
  output_hash: sha256,
  result_hash: sha256,
  integrity_hash: sha256,
}).strict();

export const JudgementV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.judgement),
  attempt_id: nonEmpty,
  judge_id: nonEmpty,
  judge_version: nonEmpty,
  verdict: z.enum(['better', 'same', 'worse']),
  evidence_hash: sha256,
}).strict();

export const TerminalClassSchema = z.enum([
  'resolved',
  'model_failure',
  'safety_failure',
  'harness_failure',
  'environment_failure',
  'grader_failure',
  'invalid_case',
  'timeout',
  'cancelled',
]);

export const NormalizedResultV1Schema = z.object({
  schema_version: z.literal(SCHEMA_VERSIONS.normalizedResult),
  attempt_id: nonEmpty,
  resolved: z.boolean(),
  terminal_class: TerminalClassSchema,
  session_id: nonEmpty.nullable(),
  started_at: utcTimestamp,
  ended_at: utcTimestamp,
  elapsed_ms: z.number().int().nonnegative(),
  cost: CostEvidenceSchema,
  patch_hash: sha256.nullable(),
  terminal_evidence_hash: sha256,
}).strict().superRefine((value, context) => {
  if (value.resolved !== (value.terminal_class === 'resolved')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resolved'], message: 'resolved must agree with terminal_class' });
  }
  if (Date.parse(value.ended_at) < Date.parse(value.started_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ended_at'], message: 'ended_at precedes started_at' });
  }
});

export const SCHEMA_REGISTRY = Object.freeze({
  [SCHEMA_VERSIONS.caseRef]: BenchmarkCaseRefV1Schema,
  [SCHEMA_VERSIONS.evalCase]: EvalCaseV1Schema,
  [SCHEMA_VERSIONS.attempt]: AttemptV1Schema,
  [SCHEMA_VERSIONS.graderResult]: GraderResultV1Schema,
  [SCHEMA_VERSIONS.judgement]: JudgementV1Schema,
  [SCHEMA_VERSIONS.normalizedResult]: NormalizedResultV1Schema,
  [SCHEMA_VERSIONS.executionEnvelope]: JunoExecutionEnvelopeV1Schema,
  [SCHEMA_VERSIONS.graderReceipt]: GraderReceiptV1Schema,
} as const);

export type BenchmarkCaseRefV1 = z.infer<typeof BenchmarkCaseRefV1Schema>;
export type EvalCaseV1 = z.infer<typeof EvalCaseV1Schema>;
export type AttemptV1 = z.infer<typeof AttemptV1Schema>;
export type GraderResultV1 = z.infer<typeof GraderResultV1Schema>;
export type JudgementV1 = z.infer<typeof JudgementV1Schema>;
export type NormalizedResultV1 = z.infer<typeof NormalizedResultV1Schema>;
export type JunoExecutionEnvelopeV1 = z.infer<typeof JunoExecutionEnvelopeV1Schema>;
export type GraderReceiptV1 = z.infer<typeof GraderReceiptV1Schema>;
export type CostEvidence = z.infer<typeof CostEvidenceSchema>;
