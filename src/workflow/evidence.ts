import { canonicalHash, canonicalJson } from '../contracts/canonical.js';
import { CostEvidenceSchema, type CostEvidence } from '../contracts/schemas.js';
import { PersistentTypedResourceLocks } from '../execution/resource-lock.js';
import { ImmutableArtifactRegistry, type ArtifactReference, type ManifestEntry } from '../registry/index.js';
import type { WorkflowExecutionPlan } from './plan.js';

export const WORKFLOW_CANDIDATE_TRUTH_SCHEMA_VERSION = 'juno_benchmark_workflow_candidate_truth.v1' as const;
export const WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION = 'juno_benchmark_workflow_evidence_receipt.v1' as const;
export const WORKFLOW_JUDGEMENT_SCHEMA_VERSION = 'juno_benchmark_workflow_judgement.v1' as const;
export const WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION = 'juno_benchmark_workflow_rejudge_receipt.v1' as const;
export const WORKFLOW_REPORT_SCHEMA_VERSION = 'juno_benchmark_workflow_report.v1' as const;

type Hash = `sha256:${string}`;
export interface WorkflowCandidateEvidence {
  readonly outer_session_id: string;
  readonly nested_session_ids: readonly string[];
  readonly started_at: string;
  readonly ended_at: string;
  readonly runtime_ms: number;
  readonly cost: CostEvidence;
  readonly candidate_outcome: { readonly status: 'success' | 'failure' };
  readonly harness_validity: { readonly status: 'valid' | 'invalid'; readonly reason: string | null };
  readonly transcript: string;
  readonly artifacts: Readonly<Record<string, string>>;
}
export interface GovernedWorkflowJudgeDecision { readonly resolved: boolean; readonly evidence: string }
export type GovernedWorkflowJudgeRunner = (input: {
  readonly judge: WorkflowExecutionPlan['policy']['judge'];
  readonly scoring_id: string;
  readonly blinded_candidate: string;
}) => Promise<GovernedWorkflowJudgeDecision>;

export interface WorkflowJudgement {
  readonly schema_version: typeof WORKFLOW_JUDGEMENT_SCHEMA_VERSION;
  readonly judgement_id: Hash;
  readonly candidate_truth_hash: Hash;
  readonly scoring_id: string;
  readonly judge: WorkflowExecutionPlan['policy']['judge'];
  readonly judge_policy_hash: Hash;
  readonly generation: number;
  readonly resolved: boolean;
  readonly evidence_hash: Hash;
}
export interface WorkflowEvidenceReceipt {
  readonly schema_version: typeof WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION;
  readonly plan_id: Hash;
  readonly policy_semantics_sha256: Hash;
  readonly dispatch_id: Hash;
  readonly invocation_hash: Hash;
  readonly model: string;
  readonly attempt: number;
  readonly step_id: string;
  readonly scoring_id: string;
  readonly identity: { readonly requested_provider: string; readonly requested_model: string; readonly observed_provider: string; readonly observed_model: string };
  readonly sessions: { readonly outer_session_id: string; readonly nested_session_ids: readonly string[] };
  readonly runtime: { readonly started_at: string; readonly ended_at: string; readonly runtime_ms: number };
  readonly cost: CostEvidence;
  readonly candidate_outcome: { readonly status: 'success' | 'failure' };
  readonly harness_validity: { readonly status: 'valid' | 'invalid'; readonly reason: string | null };
  readonly judge_outcome: WorkflowJudgement;
  readonly dispatch_recovery: { readonly recovered: boolean; readonly dispatch_count: 1; readonly recovery_count: 0 | 1; readonly runner_run_id: string; readonly effect: 'none' | 'completed' };
  readonly evidence_ref: ArtifactReference;
  readonly artifacts_ref: ArtifactReference;
  readonly candidate_truth_ref: ArtifactReference;
  readonly candidate_truth_hash: Hash;
  readonly redaction: { readonly patterns: number; readonly replacements: number; readonly clean: true; readonly retained_prompt: boolean; readonly evidence_hash: Hash };
  readonly terminal_class: 'resolved' | 'candidate_failure' | 'harness_invalid' | 'judge_failure';
  readonly receipt_hash: Hash;
}

interface CandidateTruth {
  readonly schema_version: typeof WORKFLOW_CANDIDATE_TRUTH_SCHEMA_VERSION;
  readonly plan_id: Hash; readonly dispatch_id: Hash; readonly invocation_hash: Hash;
  readonly step_id: string; readonly scoring_id: string;
  readonly candidate_outcome: WorkflowEvidenceReceipt['candidate_outcome'];
  readonly harness_validity: WorkflowEvidenceReceipt['harness_validity'];
  readonly evidence_ref: ArtifactReference; readonly artifacts_ref: ArtifactReference;
}

function assertHash(value: string, label: string): asserts value is Hash {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a canonical SHA-256`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
async function append(registry: ImmutableArtifactRegistry, experimentId: string, role: string, value: unknown): Promise<ArtifactReference> {
  const reference = await registry.put(role, `${canonicalJson(value)}\n`);
  const entries = await registry.verifyExperiment(experimentId);
  if (!entries.some((entry) => entry.role === role && entry.sha256 === reference.sha256)) await registry.append(experimentId, reference);
  return reference;
}
function patterns(values: readonly string[]): RegExp[] {
  return [...new Set(values)].map((value) => { try { return new RegExp(value, 'gu'); } catch { throw new Error(`invalid workflow redaction pattern: ${value}`); } });
}
function redact(text: string, configured: readonly RegExp[], count: { value: number }): string {
  let result = text;
  for (const pattern of configured) result = result.replace(pattern, () => { count.value += 1; return '[REDACTED]'; });
  return result;
}
function validateEvidence(evidence: WorkflowCandidateEvidence): void {
  if (!evidence.outer_session_id.trim() || evidence.nested_session_ids.length === 0 || evidence.nested_session_ids.some((id) => !id.trim())
      || new Set(evidence.nested_session_ids).size !== evidence.nested_session_ids.length) throw new Error('workflow session identity is incomplete');
  if (!Number.isFinite(evidence.runtime_ms) || evidence.runtime_ms < 0 || !Number.isInteger(evidence.runtime_ms)
      || !Number.isFinite(Date.parse(evidence.started_at)) || !Number.isFinite(Date.parse(evidence.ended_at))
      || Date.parse(evidence.ended_at) < Date.parse(evidence.started_at)) throw new Error('workflow runtime evidence is invalid');
  CostEvidenceSchema.parse(evidence.cost);
  if ((evidence.harness_validity.status === 'valid') !== (evidence.harness_validity.reason === null)) throw new Error('workflow harness validity/reason is inconsistent');
}
function judgementCore(input: { candidateTruthHash: Hash; scoringId: string; judge: WorkflowExecutionPlan['policy']['judge']; generation: number; resolved: boolean; evidence: string }): Omit<WorkflowJudgement, 'judgement_id'> {
  return { schema_version: WORKFLOW_JUDGEMENT_SCHEMA_VERSION, candidate_truth_hash: input.candidateTruthHash, scoring_id: input.scoringId,
    judge: input.judge, judge_policy_hash: canonicalHash(input.judge), generation: input.generation, resolved: input.resolved, evidence_hash: canonicalHash(input.evidence) };
}
function validateJudgement(value: unknown): WorkflowJudgement {
  const item = object(value, 'workflow judgement') as unknown as WorkflowJudgement;
  assertHash(item.judgement_id, 'judgement_id'); assertHash(item.candidate_truth_hash, 'candidate_truth_hash'); assertHash(item.judge_policy_hash, 'judge_policy_hash'); assertHash(item.evidence_hash, 'evidence_hash');
  const { judgement_id, ...core } = item;
  if (judgement_id !== canonicalHash(core) || item.judge_policy_hash !== canonicalHash(item.judge) || !Number.isInteger(item.generation) || item.generation < 1 || typeof item.resolved !== 'boolean') throw new Error('workflow judgement integrity is invalid');
  return item;
}

export function verifyWorkflowEvidenceReceiptValue(value: unknown): WorkflowEvidenceReceipt {
  const receipt = object(value, 'workflow evidence receipt') as unknown as WorkflowEvidenceReceipt;
  if (receipt.schema_version !== WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION) throw new Error('workflow evidence receipt schema is invalid');
  for (const [label, hash] of [['plan_id', receipt.plan_id], ['policy_semantics_sha256', receipt.policy_semantics_sha256], ['dispatch_id', receipt.dispatch_id], ['invocation_hash', receipt.invocation_hash], ['candidate_truth_hash', receipt.candidate_truth_hash], ['receipt_hash', receipt.receipt_hash]] as const) assertHash(hash, label);
  CostEvidenceSchema.parse(receipt.cost); validateJudgement(receipt.judge_outcome);
  const { receipt_hash, ...core } = receipt;
  if (receipt_hash !== canonicalHash(core)) throw new Error(`workflow evidence receipt integrity failed for ${receipt.dispatch_id}`);
  if (receipt.judge_outcome.candidate_truth_hash !== receipt.candidate_truth_hash || receipt.judge_outcome.scoring_id !== receipt.scoring_id) throw new Error('workflow evidence judge binding is invalid');
  if (receipt.terminal_class === 'resolved' && (receipt.candidate_outcome.status !== 'success' || receipt.harness_validity.status !== 'valid' || !receipt.judge_outcome.resolved)) throw new Error('workflow resolved truth is inconsistent');
  return receipt;
}

export async function retainAndGradeWorkflowStep(input: {
  readonly registry: ImmutableArtifactRegistry; readonly experimentId: string; readonly plan: WorkflowExecutionPlan;
  readonly dispatchId: Hash; readonly invocationHash: Hash; readonly model: string; readonly provider: string; readonly attempt: number; readonly stepId: string;
  readonly observedProvider: string; readonly observedModel: string; readonly runnerRunId: string; readonly effect: 'none' | 'completed'; readonly recovered: boolean;
  readonly evidence: WorkflowCandidateEvidence; readonly judge: GovernedWorkflowJudgeRunner;
  readonly beforeJudgeDispatch: () => Promise<void>;
}): Promise<WorkflowEvidenceReceipt> {
  validateEvidence(input.evidence);
  if (input.observedProvider !== input.provider || input.observedModel !== input.model) throw new Error('workflow observed provider/model identity is incomplete or mismatched');
  const policy = input.plan.policy.steps.find((item) => item.step_id === input.stepId);
  if (policy === undefined) throw new Error(`workflow evidence policy missing for ${input.stepId}`);
  const configured = patterns([...input.plan.policy.redaction.secret_patterns, ...policy.redaction.patterns]); const replacements = { value: 0 };
  const transcript = redact(input.evidence.transcript, configured, replacements);
  const artifacts = Object.fromEntries(Object.entries(input.evidence.artifacts).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, redact(value, configured, replacements)]));
  const retainedText = JSON.stringify({ transcript, artifacts });
  for (const pattern of configured) { pattern.lastIndex = 0; if (pattern.test(retainedText)) throw new Error('workflow evidence redaction failed closed'); }
  const evidenceRef = await append(input.registry, input.experimentId, 'workflow-evidence', { transcript });
  const artifactsRef = await append(input.registry, input.experimentId, 'workflow-artifacts', artifacts);
  const harnessValidity: WorkflowEvidenceReceipt['harness_validity'] = input.evidence.harness_validity;
  const candidateTruth: CandidateTruth = { schema_version: WORKFLOW_CANDIDATE_TRUTH_SCHEMA_VERSION, plan_id: input.plan.plan_id as Hash,
    dispatch_id: input.dispatchId, invocation_hash: input.invocationHash, step_id: input.stepId, scoring_id: policy.scoring_id,
    candidate_outcome: input.evidence.candidate_outcome, harness_validity: harnessValidity, evidence_ref: evidenceRef, artifacts_ref: artifactsRef };
  const candidateTruthRef = await append(input.registry, input.experimentId, 'workflow-candidate-truth', candidateTruth);
  const candidateTruthHash = canonicalHash(candidateTruth);
  const blinded = canonicalJson({ schema_version: 'juno_benchmark_blinded_candidate.v1', scoring_id: policy.scoring_id,
    candidate_truth_hash: candidateTruthHash, transcript, artifacts });
  await input.beforeJudgeDispatch();
  const decision = await input.judge({ judge: input.plan.policy.judge, scoring_id: policy.scoring_id, blinded_candidate: blinded });
  if (typeof decision.resolved !== 'boolean' || typeof decision.evidence !== 'string') throw new Error('workflow judge must return binary resolved truth and evidence');
  const eligible = input.evidence.candidate_outcome.status === 'success' && harnessValidity.status === 'valid';
  const judgementWithoutId = judgementCore({ candidateTruthHash, scoringId: policy.scoring_id, judge: input.plan.policy.judge, generation: 1,
    resolved: eligible && decision.resolved, evidence: decision.evidence });
  const judgement: WorkflowJudgement = { ...judgementWithoutId, judgement_id: canonicalHash(judgementWithoutId) };
  await append(input.registry, input.experimentId, 'workflow-judgement', judgement);
  const redactionCore = { patterns: configured.length, replacements: replacements.value, clean: true as const,
    retained_prompt: input.plan.policy.redaction.retain_prompts && policy.redaction.retain_prompt };
  const terminalClass: WorkflowEvidenceReceipt['terminal_class'] = harnessValidity.status === 'invalid' ? 'harness_invalid'
    : input.evidence.candidate_outcome.status === 'failure' ? 'candidate_failure' : judgement.resolved ? 'resolved' : 'judge_failure';
  const core = { schema_version: WORKFLOW_EVIDENCE_RECEIPT_SCHEMA_VERSION, plan_id: input.plan.plan_id as Hash,
    policy_semantics_sha256: input.plan.policy_semantics_sha256 as Hash, dispatch_id: input.dispatchId, invocation_hash: input.invocationHash,
    model: input.model, attempt: input.attempt, step_id: input.stepId, scoring_id: policy.scoring_id,
    identity: { requested_provider: input.provider, requested_model: input.model, observed_provider: input.observedProvider, observed_model: input.observedModel },
    sessions: { outer_session_id: input.evidence.outer_session_id, nested_session_ids: input.evidence.nested_session_ids },
    runtime: { started_at: input.evidence.started_at, ended_at: input.evidence.ended_at, runtime_ms: input.evidence.runtime_ms }, cost: input.evidence.cost,
    candidate_outcome: input.evidence.candidate_outcome, harness_validity: harnessValidity, judge_outcome: judgement,
    dispatch_recovery: { recovered: input.recovered, dispatch_count: 1 as const, recovery_count: input.recovered ? 1 as const : 0 as const, runner_run_id: input.runnerRunId, effect: input.effect },
    evidence_ref: evidenceRef, artifacts_ref: artifactsRef, candidate_truth_ref: candidateTruthRef, candidate_truth_hash: candidateTruthHash,
    redaction: { ...redactionCore, evidence_hash: canonicalHash(redactionCore) }, terminal_class: terminalClass };
  const receipt: WorkflowEvidenceReceipt = { ...core, receipt_hash: canonicalHash(core) };
  await append(input.registry, input.experimentId, 'workflow-evidence-receipt', receipt);
  return verifyWorkflowEvidenceReceiptValue(receipt);
}

async function readJson(registry: ImmutableArtifactRegistry, entry: ArtifactReference): Promise<unknown> {
  return JSON.parse((await registry.read(entry)).toString('utf8')) as unknown;
}
interface RejudgeReceipt { readonly schema_version: typeof WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION; readonly source_receipt_hash: Hash; readonly candidate_truth_hash: Hash; readonly prior_judgement_id: Hash; readonly judgement: WorkflowJudgement; readonly integrity_hash: Hash }
function validateRejudgeReceipt(value: unknown): RejudgeReceipt {
  const receipt = object(value, 'workflow rejudge receipt') as unknown as RejudgeReceipt;
  if (receipt.schema_version !== WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION) throw new Error('workflow rejudge receipt schema is invalid');
  const judgement = validateJudgement(receipt.judgement); const { integrity_hash, ...core } = receipt;
  if (integrity_hash !== canonicalHash(core) || judgement.candidate_truth_hash !== receipt.candidate_truth_hash) throw new Error('workflow rejudge receipt integrity is invalid');
  return receipt;
}
async function rejudgeHistory(registry: ImmutableArtifactRegistry, experimentId: string, receipt: WorkflowEvidenceReceipt): Promise<readonly RejudgeReceipt[]> {
  const history: RejudgeReceipt[] = [];
  for (const entry of (await registry.verifyExperiment(experimentId)).filter((item) => item.role === 'workflow-rejudge-receipt')) {
    const candidate = validateRejudgeReceipt(await readJson(registry, entry));
    if (candidate.source_receipt_hash === receipt.receipt_hash) history.push(candidate);
  }
  history.sort((left, right) => left.judgement.generation - right.judgement.generation);
  let prior = receipt.judge_outcome;
  for (const item of history) {
    if (item.prior_judgement_id !== prior.judgement_id || item.judgement.generation !== prior.generation + 1
        || item.candidate_truth_hash !== receipt.candidate_truth_hash) throw new Error('workflow rejudge generation chain is invalid');
    prior = item.judgement;
  }
  return history;
}

export async function verifyWorkflowEvidenceReceipt(registry: ImmutableArtifactRegistry, receipt: WorkflowEvidenceReceipt): Promise<WorkflowEvidenceReceipt> {
  const verified = verifyWorkflowEvidenceReceiptValue(receipt);
  for (const reference of [verified.evidence_ref, verified.artifacts_ref, verified.candidate_truth_ref]) await registry.read(reference);
  const truth = object(await readJson(registry, verified.candidate_truth_ref), 'candidate truth') as unknown as CandidateTruth;
  if (canonicalHash(truth) !== verified.candidate_truth_hash || truth.plan_id !== verified.plan_id || truth.dispatch_id !== verified.dispatch_id
      || truth.invocation_hash !== verified.invocation_hash || truth.scoring_id !== verified.scoring_id) throw new Error('workflow candidate truth binding is invalid');
  return verified;
}

export async function rejudgeRetainedWorkflowStep(input: {
  readonly registry: ImmutableArtifactRegistry; readonly experimentId: string; readonly receipt: WorkflowEvidenceReceipt; readonly trustedReceiptHash: Hash;
  readonly expectedPolicySemanticsHash: Hash; readonly judge: WorkflowExecutionPlan['policy']['judge']; readonly runner: GovernedWorkflowJudgeRunner;
  readonly locks: PersistentTypedResourceLocks;
}): Promise<WorkflowJudgement> {
  const receipt = await verifyWorkflowEvidenceReceipt(input.registry, input.receipt);
  if (receipt.receipt_hash !== input.trustedReceiptHash) throw new Error('workflow receipt does not match trusted immutable digest');
  if (receipt.policy_semantics_sha256 !== input.expectedPolicySemanticsHash) throw new Error('workflow grader-policy drift detected');
  const expectedHistory = await rejudgeHistory(input.registry, input.experimentId, receipt);
  const expectedPrior = expectedHistory.at(-1)?.judgement ?? receipt.judge_outcome;
  const expectedGeneration = expectedPrior.generation + 1;
  const lease = await input.locks.acquire([{ type: 'workflow_rejudge', id: canonicalHash({ experiment_id: input.experimentId,
    plan_id: receipt.plan_id, source_receipt_hash: receipt.receipt_hash }) }]);
  try {
    const truth = object(await readJson(input.registry, receipt.candidate_truth_ref), 'candidate truth') as unknown as CandidateTruth;
    const evidence = await readJson(input.registry, truth.evidence_ref); const artifacts = await readJson(input.registry, truth.artifacts_ref);
    const history = await rejudgeHistory(input.registry, input.experimentId, receipt);
    const prior = history.at(-1)?.judgement ?? receipt.judge_outcome;
    if (prior.judgement_id !== expectedPrior.judgement_id || prior.generation + 1 !== expectedGeneration) {
      throw new Error('workflow rejudge generation changed while waiting for durable admission');
    }
    const blinded = canonicalJson({ schema_version: 'juno_benchmark_blinded_candidate.v1', scoring_id: receipt.scoring_id,
      candidate_truth_hash: receipt.candidate_truth_hash, transcript: object(evidence, 'candidate evidence')['transcript'], artifacts });
    const generation = expectedGeneration;
    for (const entry of (await input.registry.verifyExperiment(input.experimentId)).filter((item) => item.role === 'workflow-rejudge-intent')) {
      const priorIntent = object(await readJson(input.registry, entry), 'workflow rejudge intent');
      if (priorIntent['source_receipt_hash'] === receipt.receipt_hash && priorIntent['generation'] === generation) {
        throw new Error('manual recovery required: prior governed rejudge dispatch has an ambiguous external effect');
      }
    }
    const intentCore = { schema_version: 'juno_benchmark_workflow_rejudge_intent.v1', plan_id: receipt.plan_id, source_receipt_hash: receipt.receipt_hash,
      generation, purpose: 'rejudge' as const, judge_policy_hash: canonicalHash(input.judge) };
    const intent = await input.registry.put('workflow-rejudge-intent', `${canonicalJson(intentCore)}\n`);
    await input.registry.append(input.experimentId, intent);
    const decision = await input.runner({ judge: input.judge, scoring_id: receipt.scoring_id, blinded_candidate: blinded });
    const eligible = receipt.candidate_outcome.status === 'success' && receipt.harness_validity.status === 'valid';
    const core = judgementCore({ candidateTruthHash: receipt.candidate_truth_hash, scoringId: receipt.scoring_id, judge: input.judge,
      generation, resolved: eligible && decision.resolved, evidence: decision.evidence });
    const judgement: WorkflowJudgement = { ...core, judgement_id: canonicalHash(core) };
    await append(input.registry, input.experimentId, 'workflow-judgement', judgement);
    const rejudgeCore = { schema_version: WORKFLOW_REJUDGE_RECEIPT_SCHEMA_VERSION, source_receipt_hash: receipt.receipt_hash,
      candidate_truth_hash: receipt.candidate_truth_hash, prior_judgement_id: prior.judgement_id, judgement };
    await append(input.registry, input.experimentId, 'workflow-rejudge-receipt', { ...rejudgeCore, integrity_hash: canonicalHash(rejudgeCore) });
    return judgement;
  } finally {
    await lease.release();
  }
}

export interface WorkflowExperimentReport {
  readonly schema_version: typeof WORKFLOW_REPORT_SCHEMA_VERSION; readonly report_id: Hash; readonly plan_id: Hash;
  readonly receipt_count: number; readonly expected_receipt_count: number;
  readonly totals: { readonly resolved: number; readonly candidate_failures: number; readonly harness_invalid: number; readonly judge_failures: number; readonly runtime_ms: number; readonly complete_cost_usd: number; readonly observed_cost_usd: number; readonly incomplete_cost_receipts: number };
  readonly invalidity: Readonly<Record<string, number>>;
  readonly steps: readonly { readonly step_id: string; readonly scoring_id: string; readonly receipts: number; readonly resolved: number; readonly harness_invalid: number }[];
  readonly models: readonly { readonly model: string; readonly receipts: number; readonly resolved: number; readonly harness_invalid: number; readonly runtime_ms: number; readonly complete_cost_usd: number; readonly observed_cost_usd: number }[];
  readonly comparison: readonly { readonly step_id: string; readonly by_model: Readonly<Record<string, boolean | null>> }[];
}
export async function buildWorkflowExperimentReport(registry: ImmutableArtifactRegistry, plan: WorkflowExecutionPlan): Promise<WorkflowExperimentReport> {
  const experimentId = `workflow-${plan.plan_id.slice(7)}`; const entries = await registry.verifyExperiment(experimentId);
  const receipts: WorkflowEvidenceReceipt[] = [];
  for (const entry of entries.filter((item) => item.role === 'workflow-evidence-receipt')) receipts.push(await verifyWorkflowEvidenceReceipt(registry, verifyWorkflowEvidenceReceiptValue(await readJson(registry, entry))));
  const effectiveJudgements = new Map<Hash, WorkflowJudgement>();
  for (const receipt of receipts) effectiveJudgements.set(receipt.receipt_hash, (await rejudgeHistory(registry, experimentId, receipt)).at(-1)?.judgement ?? receipt.judge_outcome);
  const terminalClass = (receipt: WorkflowEvidenceReceipt): WorkflowEvidenceReceipt['terminal_class'] => receipt.harness_validity.status === 'invalid' ? 'harness_invalid'
    : receipt.candidate_outcome.status === 'failure' ? 'candidate_failure' : effectiveJudgements.get(receipt.receipt_hash)!.resolved ? 'resolved' : 'judge_failure';
  const expected = plan.execution_order.map((item) => `${item.model}\0${item.attempt}\0${item.step_id}`);
  const observed = receipts.map((item) => `${item.model}\0${item.attempt}\0${item.step_id}`);
  if (receipts.length !== expected.length || new Set(observed).size !== observed.length || expected.some((key) => !observed.includes(key))) throw new Error('workflow evidence receipt cardinality/bindings are incomplete');
  if (receipts.some((item) => item.plan_id !== plan.plan_id || item.policy_semantics_sha256 !== plan.policy_semantics_sha256)) throw new Error('workflow evidence policy drift detected');
  const invalidity: Record<string, number> = {};
  for (const receipt of receipts.filter((item) => item.harness_validity.status === 'invalid')) { const reason = receipt.harness_validity.reason ?? 'unspecified'; invalidity[reason] = (invalidity[reason] ?? 0) + 1; }
  const summarize = (items: readonly WorkflowEvidenceReceipt[]) => ({ receipts: items.length, resolved: items.filter((item) => terminalClass(item) === 'resolved').length,
    harness_invalid: items.filter((item) => terminalClass(item) === 'harness_invalid').length, runtime_ms: items.reduce((sum, item) => sum + item.runtime.runtime_ms, 0),
    complete_cost_usd: items.reduce((sum, item) => sum + (item.cost.completeness === 'complete' ? item.cost.usd : 0), 0),
    observed_cost_usd: items.reduce((sum, item) => sum + (item.cost.usd ?? 0), 0) });
  const models = plan.models.map((model) => ({ model, ...summarize(receipts.filter((item) => item.model === model)) }));
  const steps = plan.selected_step_ids.map((stepId) => { const items = receipts.filter((item) => item.step_id === stepId); const policy = plan.policy.steps.find((item) => item.step_id === stepId)!;
    return { step_id: stepId, scoring_id: policy.scoring_id, receipts: items.length, resolved: items.filter((item) => terminalClass(item) === 'resolved').length, harness_invalid: items.filter((item) => terminalClass(item) === 'harness_invalid').length }; });
  const comparison = plan.selected_step_ids.map((stepId) => ({ step_id: stepId, by_model: Object.fromEntries(plan.models.map((model) => {
    const items = receipts.filter((item) => item.step_id === stepId && item.model === model); return [model, items.some((item) => item.harness_validity.status === 'invalid') ? null : items.every((item) => effectiveJudgements.get(item.receipt_hash)!.resolved)];
  })) }));
  const totals = { resolved: receipts.filter((item) => terminalClass(item) === 'resolved').length, candidate_failures: receipts.filter((item) => terminalClass(item) === 'candidate_failure').length,
    harness_invalid: receipts.filter((item) => terminalClass(item) === 'harness_invalid').length, judge_failures: receipts.filter((item) => terminalClass(item) === 'judge_failure').length,
    runtime_ms: receipts.reduce((sum, item) => sum + item.runtime.runtime_ms, 0), complete_cost_usd: receipts.reduce((sum, item) => sum + (item.cost.completeness === 'complete' ? item.cost.usd : 0), 0),
    observed_cost_usd: receipts.reduce((sum, item) => sum + (item.cost.usd ?? 0), 0),
    incomplete_cost_receipts: receipts.filter((item) => item.cost.completeness !== 'complete').length };
  const core = { schema_version: WORKFLOW_REPORT_SCHEMA_VERSION, plan_id: plan.plan_id as Hash, receipt_count: receipts.length, expected_receipt_count: expected.length,
    totals, invalidity: Object.fromEntries(Object.entries(invalidity).sort(([a], [b]) => a.localeCompare(b))), steps, models, comparison };
  return { ...core, report_id: canonicalHash(core) };
}
export async function storeWorkflowExperimentReport(registry: ImmutableArtifactRegistry, plan: WorkflowExecutionPlan): Promise<WorkflowExperimentReport> {
  const report = await buildWorkflowExperimentReport(registry, plan); const experimentId = `workflow-${plan.plan_id.slice(7)}`;
  await append(registry, experimentId, 'workflow-report', report);
  for (const step of report.steps) await append(registry, experimentId, 'workflow-step-report', {
    schema_version: 'juno_benchmark_workflow_step_report.v1', report_id: report.report_id, plan_id: report.plan_id, ...step,
    comparison: report.comparison.find((item) => item.step_id === step.step_id)!.by_model,
  });
  return report;
}

export async function readWorkflowEvidenceReceipts(registry: ImmutableArtifactRegistry, experimentId: string): Promise<readonly WorkflowEvidenceReceipt[]> {
  const entries: readonly ManifestEntry[] = await registry.verifyExperiment(experimentId); const receipts: WorkflowEvidenceReceipt[] = [];
  for (const entry of entries.filter((item) => item.role === 'workflow-evidence-receipt')) receipts.push(await verifyWorkflowEvidenceReceipt(registry, verifyWorkflowEvidenceReceiptValue(await readJson(registry, entry))));
  return Object.freeze(receipts);
}
