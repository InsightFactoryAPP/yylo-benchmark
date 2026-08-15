import { canonicalHash, sha256Hex } from '../contracts/canonical.js';
import type { CostEvidence } from '../contracts/schemas.js';

export const DAILY_OPS_WORKFLOW_SCHEMA = 'juno_benchmark_daily_ops_workflow.v1' as const;
export const DAILY_OPS_PLAN_SCHEMA = 'juno_benchmark_daily_ops_plan.v1' as const;
export const DAILY_OPS_STEP_RECEIPT_SCHEMA = 'juno_benchmark_daily_ops_step_receipt.v1' as const;

export type SharedResource = 'PROD_IF_BACKEND' | 'PROD_INSIGHTAGENT_BACKEND' | 'DATA_2026_PROVIDER';
export const SHARED_RESOURCE_ORDER: readonly SharedResource[] = Object.freeze([
  'PROD_IF_BACKEND', 'PROD_INSIGHTAGENT_BACKEND', 'DATA_2026_PROVIDER',
]);

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
  if (!definition.definition_path.startsWith('.juno_task/workflows/') || definition.definition_path.includes('..')) throw new Error('workflow definition must bind a tracked workflow path');
  assertHash(definition.definition_hash, 'definition_hash');
  if (definition.steps.length !== 13) throw new Error('Daily Ops workflow must contain exactly 13 steps');
  const stepIds = definition.steps.map((step) => step.step_id); const scoringIds = definition.steps.map((step) => step.scoring_id);
  if (new Set(stepIds).size !== 13 || new Set(scoringIds).size !== 13 || definition.steps.some((step) => !step.step_id.trim() || !step.scoring_id.trim() || !step.prompt.trim())) throw new Error('Daily Ops step and scoring identities must be non-empty and unique');
  for (const step of definition.steps) orderedResources(step.resources);
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
  const observedDefinitionHash = `sha256:${sha256Hex(input.definitionBytes)}`;
  if (input.definitionBytes.byteLength === 0 || input.workflow.definition_hash !== observedDefinitionHash) {
    throw new Error(`tracked workflow definition hash mismatch for ${input.workflow.definition_path}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.runDate) || Number.isNaN(Date.parse(`${input.runDate}T00:00:00Z`))) throw new Error('run date must be an ISO calendar date');
  if (Object.entries(input.variables).some(([key, value]) => !key.trim() || typeof value !== 'string')) throw new Error('workflow variables must be named strings');
  assertHash(input.judge.prompt_hash, 'judge prompt_hash'); assertHash(input.judge.rubric_hash, 'judge rubric_hash');
  if (!input.judge.judge_id.trim() || !input.judge.judge_version.trim()) throw new Error('governed judge identity is incomplete');
  const selected = input.selectedStepIds === undefined ? input.workflow.steps.map((step) => step.step_id) : [...input.selectedStepIds];
  if (selected.length === 0 || new Set(selected).size !== selected.length) throw new Error('selected steps must be non-empty and unique');
  const selectedDefinitions = selected.map((id) => input.workflow.steps.find((step) => step.step_id === id) ?? (() => { throw new Error(`unknown Daily Ops step ${id}`); })());
  const positions = selected.map((id) => input.workflow.steps.findIndex((step) => step.step_id === id));
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) throw new Error('selected steps must preserve tracked workflow order');
  if (input.models.length === 0 || input.models.some((item) => !exactModel(item.model) || item.estimated_candidate_usd < 0 || item.estimated_judge_usd < 0 || item.estimated_runtime_ms < 0)) throw new Error('model estimates must bind exact models and non-negative spend/runtime');
  if (new Set(input.models.map((item) => item.model)).size !== input.models.length) throw new Error('estimated models must be unique');
  const resources = orderedResources([...new Set(selectedDefinitions.flatMap((step) => step.resources))]);
  const estimates = input.models.map((item) => Object.freeze({ ...item }));
  const core = {
    schema_version: DAILY_OPS_PLAN_SCHEMA, workflow: input.workflow, run_date: input.runDate,
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
  recover(input: WorkflowStepInvocation & { readonly previous: WorkflowCandidateResult }): Promise<WorkflowCandidateResult>;
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
export interface DailyOpsCheckpoint {
  readonly dispatched: Set<string>;
  readonly stalled: Map<string, WorkflowCandidateResult>;
  readonly terminal: Map<string, DailyOpsStepReceipt>;
}
export function createDailyOpsCheckpoint(): DailyOpsCheckpoint { return { dispatched: new Set(), stalled: new Map(), terminal: new Map() }; }

function secretRepresentations(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((secret) => [secret, Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]))].filter(Boolean);
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
  readonly lock: WorkflowLock; readonly checkpoint: DailyOpsCheckpoint; readonly trustedSecrets?: readonly string[];
}): Promise<readonly DailyOpsStepReceipt[]> {
  const { plan_id: claimedPlanId, ...planCore } = input.plan;
  if (claimedPlanId !== canonicalHash(planCore)) throw new Error('Daily Ops plan hash is invalid');
  if (input.plan.authorization !== 'synthetic_no_production' || input.plan.dispatch_permitted !== false || input.runner.capability !== 'synthetic_no_production') throw new Error('only synthetic no-production Daily Ops plans may execute');
  if (!input.plan.models.includes(input.model)) throw new Error('model is not bound by the Daily Ops plan');
  const receipts: DailyOpsStepReceipt[] = [];
  for (const stepId of input.plan.selected_step_ids) {
    const step = input.plan.workflow.steps.find((item) => item.step_id === stepId)!;
    const dispatchId = canonicalHash({ plan_id: input.plan.plan_id, model: input.model, step_id: stepId });
    const retained = input.checkpoint.terminal.get(dispatchId); if (retained !== undefined) { receipts.push(retained); continue; }
    const invocation = { dispatch_id: dispatchId, model: input.model, run_date: input.plan.run_date, variables: input.plan.variables, step };
    const prior = input.checkpoint.stalled.get(dispatchId); let recoveryCount = 0;
    const locked = await input.lock.withResources(step.resources, dispatchId, async () => {
      let result: WorkflowCandidateResult;
      if (prior !== undefined || input.checkpoint.dispatched.has(dispatchId)) {
        if (prior === undefined) throw new Error(`dispatch ${dispatchId} has no recoverable stalled evidence; refusing duplicate dispatch`);
        recoveryCount = 1; result = await input.runner.recover({ ...invocation, previous: prior });
      } else {
        input.checkpoint.dispatched.add(dispatchId); result = await input.runner.dispatch(invocation);
        if (result.status === 'stalled') { input.checkpoint.stalled.set(dispatchId, result); recoveryCount = 1; result = await input.runner.recover({ ...invocation, previous: result }); }
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
    const receipt: DailyOpsStepReceipt = { schema_version: DAILY_OPS_STEP_RECEIPT_SCHEMA, dispatch_id: dispatchId, model: input.model,
      step_id: step.step_id, scoring_id: step.scoring_id, outer_session_id: result.outer_session_id, nested_session_id: result.nested_session_id,
      runtime_ms: result.runtime_ms, cost: result.cost, candidate_outcome: { status: result.status, terminal_class: result.terminal_class }, recovery: { state: recoveryCount === 0 ? 'not_needed' : 'recovered', dispatch_count: 1, recovery_count: recoveryCount },
      lock_events: locked.events, redaction: redacted.receipt, candidate_hash: candidateHash, judgement };
    input.checkpoint.stalled.delete(dispatchId); input.checkpoint.terminal.set(dispatchId, receipt); receipts.push(receipt);
  }
  return Object.freeze(receipts);
}

/** Judge a retained anonymous candidate generation without accepting a candidate runner. */
export async function rejudgeDailyOps(input: { readonly receipt: DailyOpsStepReceipt; readonly judge: GovernedJudge; readonly runner: WorkflowJudgeRunner; readonly anonymousCandidate: string }): Promise<WorkflowJudgementReceipt> {
  if (canonicalHash(input.anonymousCandidate) !== input.receipt.candidate_hash) throw new Error('retained candidate does not match the step receipt');
  const candidateEligible = input.receipt.candidate_outcome.status === 'success' && input.receipt.candidate_outcome.terminal_class === 'candidate_success';
  return judgeCandidate(input.runner, input.judge, input.receipt.scoring_id, input.receipt.candidate_hash, input.anonymousCandidate, input.receipt.judgement.generation + 1, candidateEligible);
}
