import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalHash, canonicalJson, sha256Hex } from '../contracts/canonical.js';
import { CostEvidenceSchema, type CostEvidence } from '../contracts/schemas.js';

export const DAILY_OPS_WORKFLOW_SCHEMA = 'juno_benchmark_daily_ops_workflow.v1' as const;
export const DAILY_OPS_PLAN_SCHEMA = 'juno_benchmark_daily_ops_plan.v1' as const;
export const DAILY_OPS_STEP_RECEIPT_SCHEMA = 'juno_benchmark_daily_ops_step_receipt.v1' as const;
export const DAILY_OPS_CHECKPOINT_SCHEMA = 'juno_benchmark_daily_ops_checkpoint.v2' as const;

export type SharedResource = 'PROD_IF_BACKEND' | 'PROD_INSIGHTAGENT_BACKEND' | 'DATA_2026_PROVIDER';
export const SHARED_RESOURCE_ORDER: readonly SharedResource[] = Object.freeze([
  'PROD_IF_BACKEND', 'PROD_INSIGHTAGENT_BACKEND', 'DATA_2026_PROVIDER',
]);
const TrackedWorkflowSchema = z.object({
  schema_version: z.literal(DAILY_OPS_WORKFLOW_SCHEMA),
  workflow_id: z.string().trim().min(1),
  workflow_revision: z.string().trim().min(1),
  steps: z.array(z.object({
    step_id: z.string().trim().min(1), scoring_id: z.string().trim().min(1), prompt: z.string().trim().min(1),
    resources: z.array(z.enum(['PROD_IF_BACKEND', 'PROD_INSIGHTAGENT_BACKEND', 'DATA_2026_PROVIDER'])),
  }).strict()).length(13),
}).strict();

export interface DailyOpsStepDefinition {
  readonly step_id: string;
  readonly scoring_id: string;
  readonly prompt: string;
  readonly resources: readonly SharedResource[];
}
export interface DailyOpsWorkflowDefinition {
  readonly schema_version: typeof DAILY_OPS_WORKFLOW_SCHEMA;
  readonly workflow_id: string;
  readonly workflow_revision: string;
  readonly definition_path: string;
  readonly definition_hash: `sha256:${string}`;
  readonly steps: readonly DailyOpsStepDefinition[];
}
export interface GovernedJudge {
  readonly judge_id: string;
  readonly judge_version: string;
  readonly prompt_hash: `sha256:${string}`;
  readonly rubric_hash: `sha256:${string}`;
}
export interface DailyOpsModelEstimate {
  readonly model: string;
  readonly estimated_candidate_usd: number;
  readonly estimated_judge_usd: number;
  readonly estimated_runtime_ms: number;
}
export interface DailyOpsPlan {
  readonly schema_version: typeof DAILY_OPS_PLAN_SCHEMA;
  readonly plan_id: `sha256:${string}`;
  readonly workflow: DailyOpsWorkflowDefinition;
  readonly run_date: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly selected_step_ids: readonly string[];
  readonly scoring_ids: readonly string[];
  readonly models: readonly string[];
  readonly resources: readonly SharedResource[];
  readonly execution: 'strictly_sequential';
  readonly authorization: 'synthetic_no_production' | 'offline_unapproved';
  readonly dispatch_permitted: false;
  /** Credentials may enter only through the reviewed authenticated launcher fd boundary; never through this plan or candidate inputs. */
  readonly credential_boundary: { readonly protocol: 'juno_benchmark_auth_launcher.v1'; readonly injection: 'trusted_fd'; readonly retained: false };
  readonly judge: GovernedJudge;
  readonly estimates: readonly DailyOpsModelEstimate[];
  readonly estimated_total_usd: number;
  readonly estimated_total_runtime_ms: number;
}

function assertHash(value: string, label: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a canonical SHA-256`);
}
function exactModel(value: string): boolean { return /^[^:/\s]+\/[^:/\s]+$/u.test(value); }
function orderedResources(resources: readonly SharedResource[]): SharedResource[] {
  const unique = [...new Set(resources)];
  if (unique.length !== resources.length || unique.some((item) => !SHARED_RESOURCE_ORDER.includes(item))) throw new Error('workflow resources must be unique typed shared resources');
  return unique.sort((a, b) => SHARED_RESOURCE_ORDER.indexOf(a) - SHARED_RESOURCE_ORDER.indexOf(b));
}
function validateDefinition(definition: DailyOpsWorkflowDefinition): void {
  if (definition.schema_version !== DAILY_OPS_WORKFLOW_SCHEMA || !definition.workflow_id.trim() || !definition.workflow_revision.trim()) throw new Error('workflow identity is incomplete');
  const trackedWorkflowPath = definition.definition_path.startsWith('.juno_task/workflows/')
    || definition.definition_path.startsWith('juno-benchmark/workflows/');
  if (!trackedWorkflowPath || definition.definition_path.includes('..')) throw new Error('workflow definition must bind a tracked workflow path');
  assertHash(definition.definition_hash, 'definition_hash');
  if (definition.steps.length !== 13) throw new Error('Daily Ops workflow must contain exactly 13 steps');
  const stepIds = definition.steps.map((step) => step.step_id); const scoringIds = definition.steps.map((step) => step.scoring_id);
  if (new Set(stepIds).size !== 13 || new Set(scoringIds).size !== 13 || definition.steps.some((step) => !step.step_id.trim() || !step.scoring_id.trim() || !step.prompt.trim())) throw new Error('Daily Ops step and scoring identities must be non-empty and unique');
  for (const step of definition.steps) orderedResources(step.resources);
}

function workflowFromTrackedBytes(claimed: DailyOpsWorkflowDefinition, bytes: Uint8Array): DailyOpsWorkflowDefinition {
  const observedHash = `sha256:${sha256Hex(bytes)}` as const;
  if (bytes.byteLength === 0 || claimed.definition_hash !== observedHash) throw new Error(`tracked workflow definition hash mismatch for ${claimed.definition_path}`);
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error(`tracked workflow definition is not strict JSON-compatible YAML: ${claimed.definition_path}`); }
  const tracked = TrackedWorkflowSchema.parse(decoded);
  const derived: DailyOpsWorkflowDefinition = { ...tracked, definition_path: claimed.definition_path, definition_hash: observedHash };
  validateDefinition(derived);
  const claimedSemantics = { schema_version: claimed.schema_version, workflow_id: claimed.workflow_id, workflow_revision: claimed.workflow_revision, steps: claimed.steps };
  const trackedSemantics = { schema_version: derived.schema_version, workflow_id: derived.workflow_id, workflow_revision: derived.workflow_revision, steps: derived.steps };
  if (canonicalHash(claimedSemantics) !== canonicalHash(trackedSemantics)) throw new Error(`workflow semantics do not match tracked definition bytes for ${claimed.definition_path}`);
  return Object.freeze({ ...derived, steps: Object.freeze(derived.steps.map((step) => Object.freeze({ ...step, resources: Object.freeze([...step.resources]) }))) });
}

/** Build a hash-bound, dispatch-disabled plan. This function never launches a model. */
export function planDailyOps(input: {
  readonly workflow: DailyOpsWorkflowDefinition;
  /** Exact bytes read from workflow.definition_path in the trusted controller workspace. */
  readonly definitionBytes: Uint8Array;
  readonly runDate: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly selectedStepIds?: readonly string[];
  readonly models: readonly DailyOpsModelEstimate[];
  readonly judge: GovernedJudge;
  readonly authorization: DailyOpsPlan['authorization'];
}): DailyOpsPlan {
  validateDefinition(input.workflow);
  const workflow = workflowFromTrackedBytes(input.workflow, input.definitionBytes);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.runDate) || Number.isNaN(Date.parse(`${input.runDate}T00:00:00Z`))) throw new Error('run date must be an ISO calendar date');
  if (Object.entries(input.variables).some(([key, value]) => !key.trim() || typeof value !== 'string')) throw new Error('workflow variables must be named strings');
  assertHash(input.judge.prompt_hash, 'judge prompt_hash'); assertHash(input.judge.rubric_hash, 'judge rubric_hash');
  if (!input.judge.judge_id.trim() || !input.judge.judge_version.trim()) throw new Error('governed judge identity is incomplete');
  const selected = input.selectedStepIds === undefined ? workflow.steps.map((step) => step.step_id) : [...input.selectedStepIds];
  if (selected.length === 0 || new Set(selected).size !== selected.length) throw new Error('selected steps must be non-empty and unique');
  const selectedDefinitions = selected.map((id) => workflow.steps.find((step) => step.step_id === id) ?? (() => { throw new Error(`unknown Daily Ops step ${id}`); })());
  const positions = selected.map((id) => workflow.steps.findIndex((step) => step.step_id === id));
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) throw new Error('selected steps must preserve tracked workflow order');
  if (input.models.length === 0 || input.models.some((item) => !exactModel(item.model) || item.estimated_candidate_usd < 0 || item.estimated_judge_usd < 0 || item.estimated_runtime_ms < 0)) throw new Error('model estimates must bind exact models and non-negative spend/runtime');
  if (new Set(input.models.map((item) => item.model)).size !== input.models.length) throw new Error('estimated models must be unique');
  const resources = orderedResources([...new Set(selectedDefinitions.flatMap((step) => step.resources))]);
  const estimates = input.models.map((item) => Object.freeze({ ...item }));
  const core = {
    schema_version: DAILY_OPS_PLAN_SCHEMA, workflow, run_date: input.runDate,
    variables: Object.fromEntries(Object.entries(input.variables).sort(([a], [b]) => a.localeCompare(b))),
    selected_step_ids: selected, scoring_ids: selectedDefinitions.map((step) => step.scoring_id),
    models: estimates.map((item) => item.model), resources, execution: 'strictly_sequential' as const,
    authorization: input.authorization, dispatch_permitted: false as const,
    credential_boundary: { protocol: 'juno_benchmark_auth_launcher.v1' as const, injection: 'trusted_fd' as const, retained: false as const },
    judge: input.judge, estimates,
    estimated_total_usd: estimates.reduce((sum, item) => sum + item.estimated_candidate_usd + item.estimated_judge_usd, 0),
    estimated_total_runtime_ms: estimates.reduce((sum, item) => sum + item.estimated_runtime_ms, 0),
  };
  return Object.freeze({ ...core, plan_id: canonicalHash(core) });
}

export type WorkflowTerminalClass = 'candidate_success' | 'step_failure' | 'harness_invalid';
export interface WorkflowCandidateResult {
  readonly status: 'success' | 'failure' | 'stalled';
  /** Harness invalidity is retained separately and never scored as candidate failure. */
  readonly terminal_class: WorkflowTerminalClass;
  readonly outer_session_id: string;
  readonly nested_session_id: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly runtime_ms: number;
  readonly cost: CostEvidence;
  readonly transcript: string;
  readonly artifacts: Readonly<Record<string, string>>;
}
export interface WorkflowStepInvocation {
  readonly dispatch_id: string;
  readonly model: string;
  readonly run_date: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly step: DailyOpsStepDefinition;
}
export interface WorkflowCandidateRunner {
  readonly capability: 'synthetic_no_production';
  dispatch(input: WorkflowStepInvocation): Promise<WorkflowCandidateResult>;
  /** Recover the idempotent dispatch identity. `previous` is absent when interruption occurred before result persistence. */
  recover(input: WorkflowStepInvocation & { readonly previous?: WorkflowCandidateResult }): Promise<WorkflowCandidateResult>;
}
export interface WorkflowJudgeDecision { readonly resolved: boolean; readonly evidence: string }
export type WorkflowJudgeRunner = (input: { readonly judge: GovernedJudge; readonly scoring_id: string; readonly anonymous_candidate: string }) => Promise<WorkflowJudgeDecision>;
export interface WorkflowLockEvent { readonly sequence: number; readonly action: 'acquire' | 'release'; readonly resource: SharedResource; readonly dispatch_id: string }
export interface WorkflowLock {
  withResources<T>(resources: readonly SharedResource[], dispatchId: string, operation: () => Promise<T>): Promise<{ value: T; events: readonly WorkflowLockEvent[] }>;
}

/** In-process lock used by synthetic fixtures. A second holder fails rather than overlapping. */
export function createStrictSequentialLock(): WorkflowLock {
  const held = new Set<SharedResource>(); let sequence = 0;
  return { async withResources<T>(resources: readonly SharedResource[], dispatchId: string, operation: () => Promise<T>) {
    const ordered = orderedResources(resources); const events: WorkflowLockEvent[] = [];
    if (held.size !== 0) throw new Error('shared Daily Ops resource overlap detected');
    for (const resource of ordered) { held.add(resource); events.push({ sequence: ++sequence, action: 'acquire', resource, dispatch_id: dispatchId }); }
    try { return { value: await operation(), events }; }
    finally { for (const resource of [...ordered].reverse()) { held.delete(resource); events.push({ sequence: ++sequence, action: 'release', resource, dispatch_id: dispatchId }); } }
  } };
}

export interface RedactionReceipt {
  readonly schema_version: 'juno_benchmark_redaction_receipt.v1';
  readonly scanned_surfaces: readonly ['plan', 'transcript', 'artifacts'];
  readonly representations: readonly ['raw', 'hex', 'base64', 'url'];
  readonly replacements: number;
  readonly credential_boundary: 'juno_benchmark_auth_launcher.v1';
  readonly clean: true;
  readonly evidence_hash: `sha256:${string}`;
}
export interface DailyOpsStepReceipt {
  readonly schema_version: typeof DAILY_OPS_STEP_RECEIPT_SCHEMA;
  readonly dispatch_id: string;
  readonly model: string;
  readonly step_id: string;
  readonly scoring_id: string;
  readonly outer_session_id: string;
  readonly nested_session_id: string;
  readonly runtime_ms: number;
  readonly cost: CostEvidence;
  readonly candidate_outcome: { readonly status: 'success' | 'failure'; readonly terminal_class: WorkflowTerminalClass };
  readonly recovery: { readonly state: 'not_needed' | 'recovered'; readonly dispatch_count: 1; readonly recovery_count: number };
  readonly lock_events: readonly WorkflowLockEvent[];
  readonly redaction: RedactionReceipt;
  readonly candidate_hash: `sha256:${string}`;
  readonly judgement: WorkflowJudgementReceipt;
  /** Integrity of every terminal field, independently of the mutable checkpoint envelope. */
  readonly receipt_hash: `sha256:${string}`;
}
export interface WorkflowJudgementReceipt {
  readonly judgement_id: `sha256:${string}`;
  readonly candidate_hash: `sha256:${string}`;
  readonly scoring_id: string;
  readonly judge: GovernedJudge;
  readonly generation: number;
  readonly resolved: boolean;
  readonly evidence_hash: `sha256:${string}`;
}
export interface DailyOpsDispatchIntent {
  readonly dispatch_id: string;
  readonly invocation_hash: `sha256:${string}`;
}
export interface DailyOpsCheckpoint {
  readonly dispatch_intents: Map<string, DailyOpsDispatchIntent>;
  readonly stalled: Map<string, WorkflowCandidateResult>;
  readonly terminal: Map<string, DailyOpsStepReceipt>;
}
export interface DailyOpsCheckpointStore {
  load(expectedPlanId: `sha256:${string}`): Promise<DailyOpsCheckpoint>;
  save(planId: `sha256:${string}`, checkpoint: DailyOpsCheckpoint): Promise<void>;
}
interface CheckpointPayload {
  readonly schema_version: typeof DAILY_OPS_CHECKPOINT_SCHEMA;
  readonly plan_id: `sha256:${string}`;
  readonly dispatch_intents: readonly (readonly [string, DailyOpsDispatchIntent])[];
  readonly stalled: readonly (readonly [string, WorkflowCandidateResult])[];
  readonly terminal: readonly (readonly [string, DailyOpsStepReceipt])[];
}
interface CheckpointEnvelope { readonly payload: CheckpointPayload; readonly integrity_hash: `sha256:${string}` }

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const GovernedJudgeSchema = z.object({
  judge_id: z.string().trim().min(1), judge_version: z.string().trim().min(1), prompt_hash: HashSchema, rubric_hash: HashSchema,
}).strict();
const RedactionReceiptSchema = z.object({
  schema_version: z.literal('juno_benchmark_redaction_receipt.v1'),
  scanned_surfaces: z.tuple([z.literal('plan'), z.literal('transcript'), z.literal('artifacts')]),
  representations: z.tuple([z.literal('raw'), z.literal('hex'), z.literal('base64'), z.literal('url')]),
  replacements: z.number().int().nonnegative(), credential_boundary: z.literal('juno_benchmark_auth_launcher.v1'),
  clean: z.literal(true), evidence_hash: HashSchema,
}).strict();
const WorkflowJudgementReceiptSchema = z.object({
  judgement_id: HashSchema, candidate_hash: HashSchema, scoring_id: z.string().trim().min(1), judge: GovernedJudgeSchema,
  generation: z.number().int().positive(), resolved: z.boolean(), evidence_hash: HashSchema,
}).strict();
const DailyOpsStepReceiptSchema = z.object({
  schema_version: z.literal(DAILY_OPS_STEP_RECEIPT_SCHEMA), dispatch_id: HashSchema, model: z.string().trim().min(1),
  step_id: z.string().trim().min(1), scoring_id: z.string().trim().min(1), outer_session_id: z.string().trim().min(1),
  nested_session_id: z.string().trim().min(1), runtime_ms: z.number().finite().nonnegative(), cost: CostEvidenceSchema,
  candidate_outcome: z.object({ status: z.enum(['success', 'failure']), terminal_class: z.enum(['candidate_success', 'step_failure', 'harness_invalid']) }).strict(),
  recovery: z.object({ state: z.enum(['not_needed', 'recovered']), dispatch_count: z.literal(1), recovery_count: z.number().int().nonnegative() }).strict(),
  lock_events: z.array(z.object({ sequence: z.number().int().positive(), action: z.enum(['acquire', 'release']),
    resource: z.enum(['PROD_IF_BACKEND', 'PROD_INSIGHTAGENT_BACKEND', 'DATA_2026_PROVIDER']), dispatch_id: HashSchema }).strict()),
  redaction: RedactionReceiptSchema, candidate_hash: HashSchema, judgement: WorkflowJudgementReceiptSchema, receipt_hash: HashSchema,
}).strict();

function validateTerminalReceipt(value: unknown): DailyOpsStepReceipt {
  const parsed = DailyOpsStepReceiptSchema.safeParse(value);
  if (!parsed.success) throw new Error('Daily Ops terminal receipt schema is invalid');
  const receipt = parsed.data as DailyOpsStepReceipt;
  const { evidence_hash: redactionHash, ...redactionCore } = receipt.redaction;
  if (redactionHash !== canonicalHash(redactionCore)) throw new Error('Daily Ops terminal redaction integrity is invalid');
  const { judgement_id: judgementId, ...judgementCore } = receipt.judgement;
  if (judgementId !== canonicalHash(judgementCore)) throw new Error('Daily Ops terminal judgement integrity is invalid');
  const { receipt_hash: receiptHash, ...receiptCore } = receipt;
  if (receiptHash !== canonicalHash(receiptCore)) throw new Error('Daily Ops terminal receipt integrity is invalid');
  const validOutcome = (receipt.candidate_outcome.status === 'success' && receipt.candidate_outcome.terminal_class === 'candidate_success')
    || (receipt.candidate_outcome.status === 'failure' && (receipt.candidate_outcome.terminal_class === 'step_failure' || receipt.candidate_outcome.terminal_class === 'harness_invalid'));
  if (!validOutcome || (receipt.candidate_outcome.status === 'failure' && receipt.judgement.resolved)) throw new Error('Daily Ops terminal outcome is invalid');
  if ((receipt.recovery.state === 'not_needed') !== (receipt.recovery.recovery_count === 0)) throw new Error('Daily Ops terminal recovery evidence is invalid');
  return receipt;
}

export function createDailyOpsCheckpoint(): DailyOpsCheckpoint { return { dispatch_intents: new Map(), stalled: new Map(), terminal: new Map() }; }

export function serializeDailyOpsCheckpoint(planId: `sha256:${string}`, checkpoint: DailyOpsCheckpoint): string {
  assertHash(planId, 'checkpoint plan_id');
  const payload: CheckpointPayload = { schema_version: DAILY_OPS_CHECKPOINT_SCHEMA, plan_id: planId,
    dispatch_intents: [...checkpoint.dispatch_intents.entries()].sort(([a], [b]) => a.localeCompare(b)),
    stalled: [...checkpoint.stalled.entries()].sort(([a], [b]) => a.localeCompare(b)),
    terminal: [...checkpoint.terminal.entries()].sort(([a], [b]) => a.localeCompare(b)) };
  return `${canonicalJson({ payload, integrity_hash: canonicalHash(payload) })}\n`;
}

export function deserializeDailyOpsCheckpoint(serialized: string, expectedPlanId: `sha256:${string}`): DailyOpsCheckpoint {
  let envelope: CheckpointEnvelope;
  try { envelope = JSON.parse(serialized) as CheckpointEnvelope; } catch { throw new Error('Daily Ops checkpoint is not valid JSON'); }
  if (envelope === null || typeof envelope !== 'object' || envelope.payload?.schema_version !== DAILY_OPS_CHECKPOINT_SCHEMA || envelope.payload.plan_id !== expectedPlanId) {
    throw new Error('Daily Ops checkpoint plan/schema drift detected');
  }
  if (envelope.integrity_hash !== canonicalHash(envelope.payload)) throw new Error('Daily Ops checkpoint integrity verification failed');
  const { dispatch_intents: dispatchIntents, stalled, terminal } = envelope.payload;
  if (!Array.isArray(dispatchIntents) || !Array.isArray(stalled) || !Array.isArray(terminal)
      || dispatchIntents.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || entry[1] === null || typeof entry[1] !== 'object' || entry[1].dispatch_id !== entry[0]
        || !/^sha256:[0-9a-f]{64}$/u.test(entry[1].invocation_hash))
      || stalled.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
      || terminal.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) throw new Error('Daily Ops checkpoint structure is invalid');
  const validatedTerminal = terminal.map(([id, receipt]) => [id, validateTerminalReceipt(receipt)] as const);
  const checkpoint: DailyOpsCheckpoint = { dispatch_intents: new Map(dispatchIntents), stalled: new Map(stalled), terminal: new Map(validatedTerminal) };
  if (checkpoint.dispatch_intents.size !== dispatchIntents.length || checkpoint.stalled.size !== stalled.length || checkpoint.terminal.size !== terminal.length) throw new Error('Daily Ops checkpoint contains duplicate identities');
  for (const [id] of checkpoint.stalled) if (!checkpoint.dispatch_intents.has(id) || checkpoint.terminal.has(id)) throw new Error('Daily Ops stalled checkpoint state is inconsistent');
  for (const [id, receipt] of checkpoint.terminal) if (!checkpoint.dispatch_intents.has(id) || receipt.dispatch_id !== id) throw new Error('Daily Ops terminal checkpoint state is inconsistent');
  return checkpoint;
}

/** Atomic, integrity-checked persistence for restart-safe synthetic execution. */
export function createFileDailyOpsCheckpointStore(checkpointPath: string): DailyOpsCheckpointStore {
  const absolute = path.resolve(checkpointPath);
  return {
    async load(expectedPlanId) {
      let bytes: Buffer;
      try { bytes = await readFile(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createDailyOpsCheckpoint();
        throw error;
      }
      if (bytes.length > 8 * 1024 * 1024) throw new Error('Daily Ops checkpoint exceeds durable size limit');
      return deserializeDailyOpsCheckpoint(bytes.toString('utf8'), expectedPlanId);
    },
    async save(planId, checkpoint) {
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', 0o600); await handle.writeFile(serializeDailyOpsCheckpoint(planId, checkpoint)); await handle.sync(); await handle.close(); handle = undefined;
        await rename(temporary, absolute);
        const directory = await open(path.dirname(absolute), 'r'); try { await directory.sync(); } finally { await directory.close(); }
      } finally { await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
    },
  };
}

function secretRepresentations(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((secret) => [secret, Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]))].filter(Boolean);
}
function sanitizeResultForCheckpoint(result: WorkflowCandidateResult, secrets: readonly string[]): WorkflowCandidateResult {
  const values = secretRepresentations(secrets);
  const scrub = (text: string): string => { let output = text; for (const value of values) output = output.split(value).join('[REDACTED]'); return output; };
  return { ...result, transcript: scrub(result.transcript), artifacts: Object.fromEntries(Object.entries(result.artifacts).map(([name, value]) => [name, scrub(value)])) };
}
function redactCandidate(plan: DailyOpsPlan, result: WorkflowCandidateResult, secrets: readonly string[]): { anonymous: string; receipt: RedactionReceipt } {
  const values = secretRepresentations(secrets); let replacements = 0;
  const scrub = (text: string): string => { let output = text; for (const value of values) { const count = output.split(value).length - 1; replacements += count; output = output.split(value).join('[REDACTED]'); } return output; };
  const planText = scrub(JSON.stringify(plan)); const transcript = scrub(result.transcript);
  const artifacts = Object.fromEntries(Object.entries(result.artifacts).map(([name, value]) => [name, scrub(value)]));
  const retained = { plan: planText, transcript, artifacts };
  if (values.some((value) => JSON.stringify(retained).includes(value))) throw new Error('credential redaction was incomplete');
  const core = { schema_version: 'juno_benchmark_redaction_receipt.v1' as const, scanned_surfaces: ['plan', 'transcript', 'artifacts'] as const,
    representations: ['raw', 'hex', 'base64', 'url'] as const, replacements,
    credential_boundary: 'juno_benchmark_auth_launcher.v1' as const, clean: true as const };
  return { anonymous: JSON.stringify({ transcript, artifacts }), receipt: { ...core, evidence_hash: canonicalHash(core) } };
}
async function judgeCandidate(judge: WorkflowJudgeRunner, governed: GovernedJudge, scoringId: string, candidateHash: `sha256:${string}`, anonymous: string, generation: number, candidateEligible: boolean): Promise<WorkflowJudgementReceipt> {
  const decision = await judge({ judge: governed, scoring_id: scoringId, anonymous_candidate: anonymous });
  const core = { candidate_hash: candidateHash, scoring_id: scoringId, judge: governed, generation, resolved: candidateEligible && decision.resolved, evidence_hash: canonicalHash(decision.evidence) };
  return { ...core, judgement_id: canonicalHash(core) };
}

/** Execute a synthetic plan only; production/unapproved plans are structurally non-dispatchable. */
export async function runSyntheticDailyOps(input: {
  readonly plan: DailyOpsPlan; readonly model: string; readonly runner: WorkflowCandidateRunner; readonly judge: WorkflowJudgeRunner;
  readonly lock: WorkflowLock; readonly checkpointStore: DailyOpsCheckpointStore; readonly trustedSecrets?: readonly string[];
}): Promise<readonly DailyOpsStepReceipt[]> {
  const { plan_id: claimedPlanId, ...planCore } = input.plan;
  if (claimedPlanId !== canonicalHash(planCore)) throw new Error('Daily Ops plan hash is invalid');
  if (input.plan.authorization !== 'synthetic_no_production' || input.plan.dispatch_permitted !== false || input.runner.capability !== 'synthetic_no_production') throw new Error('only synthetic no-production Daily Ops plans may execute');
  if (!input.plan.models.includes(input.model)) throw new Error('model is not bound by the Daily Ops plan');
  const checkpoint = await input.checkpointStore.load(input.plan.plan_id);
  const expected: Map<string, { step: DailyOpsStepDefinition; invocationHash: `sha256:${string}` }> = new Map(input.plan.selected_step_ids.map((stepId) => {
    const step = input.plan.workflow.steps.find((item) => item.step_id === stepId)!;
    const dispatchId = canonicalHash({ plan_id: input.plan.plan_id, model: input.model, step_id: stepId });
    const invocation: WorkflowStepInvocation = { dispatch_id: dispatchId, model: input.model, run_date: input.plan.run_date, variables: input.plan.variables, step };
    return [dispatchId, { step, invocationHash: canonicalHash(invocation) }] as const;
  }));
  for (const [dispatchId, intent] of checkpoint.dispatch_intents) {
    const bound = expected.get(dispatchId);
    if (bound === undefined || intent.dispatch_id !== dispatchId || intent.invocation_hash !== bound.invocationHash) throw new Error(`dispatch intent binding is invalid for ${dispatchId}`);
  }
  for (const dispatchId of checkpoint.stalled.keys()) {
    if (!expected.has(dispatchId)) throw new Error(`checkpoint contains an unbound dispatch identity ${dispatchId}`);
  }
  for (const [dispatchId, loadedReceipt] of checkpoint.terminal) {
    const receipt = validateTerminalReceipt(loadedReceipt);
    checkpoint.terminal.set(dispatchId, receipt);
    const bound = expected.get(dispatchId);
    if (bound === undefined) throw new Error(`terminal receipt binding is invalid for ${dispatchId}`);
    const judgementBound = receipt.judgement.candidate_hash === receipt.candidate_hash
      && receipt.judgement.scoring_id === receipt.scoring_id
      && canonicalHash(receipt.judgement.judge) === canonicalHash(input.plan.judge);
    const resources = orderedResources(bound.step.resources);
    const lockEventsBound = receipt.lock_events.length === resources.length * 2
      && receipt.lock_events.every((event) => event.dispatch_id === dispatchId)
      && canonicalHash(receipt.lock_events.slice(0, resources.length).map((event) => [event.action, event.resource]))
        === canonicalHash(resources.map((resource) => ['acquire', resource]))
      && canonicalHash(receipt.lock_events.slice(resources.length).map((event) => [event.action, event.resource]))
        === canonicalHash([...resources].reverse().map((resource) => ['release', resource]));
    if (receipt.dispatch_id !== dispatchId || receipt.model !== input.model || receipt.step_id !== bound.step.step_id
        || receipt.scoring_id !== bound.step.scoring_id || !judgementBound || !lockEventsBound) throw new Error(`terminal receipt binding is invalid for ${dispatchId}`);
  }
  const receipts: DailyOpsStepReceipt[] = [];
  for (const stepId of input.plan.selected_step_ids) {
    const step = input.plan.workflow.steps.find((item) => item.step_id === stepId)!;
    const dispatchId = canonicalHash({ plan_id: input.plan.plan_id, model: input.model, step_id: stepId });
    const retained = checkpoint.terminal.get(dispatchId); if (retained !== undefined) { receipts.push(retained); continue; }
    const invocation: WorkflowStepInvocation = { dispatch_id: dispatchId, model: input.model, run_date: input.plan.run_date, variables: input.plan.variables, step };
    const invocationHash = canonicalHash(invocation);
    const prior = checkpoint.stalled.get(dispatchId); let recoveryCount = 0;
    const locked = await input.lock.withResources(step.resources, dispatchId, async () => {
      let result: WorkflowCandidateResult;
      if (prior !== undefined || checkpoint.dispatch_intents.has(dispatchId)) {
        recoveryCount = 1;
        result = await input.runner.recover({ ...invocation, ...(prior === undefined ? {} : { previous: prior }) });
      } else {
        checkpoint.dispatch_intents.set(dispatchId, { dispatch_id: dispatchId, invocation_hash: invocationHash });
        await input.checkpointStore.save(input.plan.plan_id, checkpoint); // Durable idempotency intent before any dispatch.
        result = await input.runner.dispatch(invocation);
        if (result.status === 'stalled') {
          const persisted = sanitizeResultForCheckpoint(result, input.trustedSecrets ?? []);
          checkpoint.stalled.set(dispatchId, persisted); await input.checkpointStore.save(input.plan.plan_id, checkpoint);
          recoveryCount = 1; result = await input.runner.recover({ ...invocation, previous: persisted });
        }
      }
      if (result.status === 'stalled') throw new Error(`bounded recovery remained stalled for ${stepId}`);
      return result;
    });
    const result = locked.value;
    if (!result.outer_session_id.trim() || !result.nested_session_id.trim() || result.runtime_ms < 0 || Date.parse(result.ended_at) < Date.parse(result.started_at)) throw new Error(`invalid session/runtime evidence for ${stepId}`);
    const validOutcome = (result.status === 'success' && result.terminal_class === 'candidate_success')
      || (result.status === 'failure' && (result.terminal_class === 'step_failure' || result.terminal_class === 'harness_invalid'));
    if (!validOutcome) throw new Error(`candidate status/terminal classification mismatch for ${stepId}`);
    const redacted = redactCandidate(input.plan, result, input.trustedSecrets ?? []); const candidateHash = canonicalHash(redacted.anonymous);
    const candidateEligible = result.status === 'success' && result.terminal_class === 'candidate_success';
    const judgement = await judgeCandidate(input.judge, input.plan.judge, step.scoring_id, candidateHash, redacted.anonymous, 1, candidateEligible);
    const receiptCore = { schema_version: DAILY_OPS_STEP_RECEIPT_SCHEMA, dispatch_id: dispatchId, model: input.model,
      step_id: step.step_id, scoring_id: step.scoring_id, outer_session_id: result.outer_session_id, nested_session_id: result.nested_session_id,
      runtime_ms: result.runtime_ms, cost: result.cost, candidate_outcome: { status: result.status, terminal_class: result.terminal_class }, recovery: { state: recoveryCount === 0 ? 'not_needed' as const : 'recovered' as const, dispatch_count: 1 as const, recovery_count: recoveryCount },
      lock_events: locked.events, redaction: redacted.receipt, candidate_hash: candidateHash, judgement };
    const receipt: DailyOpsStepReceipt = { ...receiptCore, receipt_hash: canonicalHash(receiptCore) };
    checkpoint.stalled.delete(dispatchId); checkpoint.terminal.set(dispatchId, receipt);
    await input.checkpointStore.save(input.plan.plan_id, checkpoint); receipts.push(receipt);
  }
  return Object.freeze(receipts);
}

/** Judge a retained anonymous candidate generation without accepting a candidate runner.
 * `trustedReceiptHash` must come from the immutable receipt ledger, never from the supplied receipt.
 */
export async function rejudgeDailyOps(input: { readonly receipt: DailyOpsStepReceipt; readonly trustedReceiptHash: `sha256:${string}`; readonly judge: GovernedJudge; readonly runner: WorkflowJudgeRunner; readonly anonymousCandidate: string }): Promise<WorkflowJudgementReceipt> {
  assertHash(input.trustedReceiptHash, 'trusted receipt_hash');
  const receipt = validateTerminalReceipt(input.receipt);
  if (receipt.receipt_hash !== input.trustedReceiptHash) throw new Error('Daily Ops terminal receipt does not match trusted digest');
  if (canonicalHash(input.anonymousCandidate) !== receipt.candidate_hash) throw new Error('retained candidate does not match the step receipt');
  const candidateEligible = receipt.candidate_outcome.status === 'success' && receipt.candidate_outcome.terminal_class === 'candidate_success';
  return judgeCandidate(input.runner, input.judge, receipt.scoring_id, receipt.candidate_hash, input.anonymousCandidate, receipt.judgement.generation + 1, candidateEligible);
}
