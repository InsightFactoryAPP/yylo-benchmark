import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AUTH_LAUNCHER_PROTOCOL } from '../auth/index.js';
import { canonicalHash, canonicalJson, sha256Hex } from '../contracts/canonical.js';
import { CostEvidenceSchema } from '../contracts/schemas.js';
import { PersistentTypedResourceLocks, type TypedResource } from '../execution/resource-lock.js';
import { ImmutableArtifactRegistry, type ArtifactReference } from '../registry/index.js';
import { readWorkflowEvidenceReceipts, retainAndGradeWorkflowStep, type GovernedWorkflowJudgeRunner, type WorkflowCandidateEvidence, type WorkflowEvidenceReceipt } from './evidence.js';
import { WORKFLOW_COMPILER_VERSION, WorkflowExecutionPlanSchema, parseWorkflowPolicyBytes, type DeterministicCommandPolicy, type WorkflowExecutionPlan, verifyWorkflowPlanBindings, workflowStepRequiresModelDispatch } from './plan.js';

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const WORKFLOW_DISPATCH_INTENT_SCHEMA_VERSION = 'juno_benchmark_workflow_dispatch_intent.v1' as const;
export const WORKFLOW_JUDGE_INTENT_SCHEMA_VERSION = 'juno_benchmark_workflow_judge_intent.v1' as const;
export const WORKFLOW_RECOVERY_INTENT_SCHEMA_VERSION = 'juno_benchmark_workflow_recovery_intent.v1' as const;
export const WORKFLOW_STEP_TERMINAL_SCHEMA_VERSION = 'juno_benchmark_workflow_step_terminal.v1' as const;

export interface WorkflowRuntimeInvocation {
  readonly dispatch_id: `sha256:${string}`; readonly invocation_hash: `sha256:${string}`; readonly plan_id: `sha256:${string}`;
  readonly model: string; readonly provider: string; readonly attempt: number; readonly step_id: string;
  readonly workflow_sha256: `sha256:${string}`; readonly workflow_bytes_base64: string;
  readonly variables: Readonly<Record<string, string | number | boolean | null>>; readonly timeout_ms: number;
  readonly deterministic_command: DeterministicCommandPolicy | null;
}
const candidateEvidence = z.object({
  outer_session_id: z.string().trim().min(1), nested_session_ids: z.array(z.string().trim().min(1)).min(1),
  started_at: z.string().datetime({ offset: true }), ended_at: z.string().datetime({ offset: true }), runtime_ms: z.number().int().nonnegative(),
  cost: CostEvidenceSchema, candidate_outcome: z.object({ status: z.enum(['success', 'failure']) }).strict(),
  harness_validity: z.object({ status: z.enum(['valid', 'invalid']), reason: z.string().trim().min(1).nullable() }).strict(),
  transcript: z.string(), artifacts: z.record(z.string()),
}).strict();
const terminalSummary = z.object({
  dispatch_id: hash, status: z.enum(['success', 'failure']), effect: z.enum(['none', 'completed']),
  runner_run_id: z.string().trim().min(1), observed_provider: z.string().trim().min(1), observed_model: z.string().trim().min(1),
}).strict();
const terminalResult = terminalSummary.extend({ evidence: candidateEvidence }).strict();
export type WorkflowRuntimeTerminalResult = z.infer<typeof terminalResult>;
export type WorkflowReconciliation =
  | { readonly state: 'terminal'; readonly result: WorkflowRuntimeTerminalResult }
  | { readonly state: 'safely_resumable' | 'proven_not_dispatched' }
  | { readonly state: 'ambiguous' };

/**
 * Implementations own Workflow Runner/Juno process details. Provider credentials
 * remain inside this reviewed boundary and are never fields of an invocation or result.
 */
export interface TrustedWorkflowDispatcher {
  readonly protocol: typeof AUTH_LAUNCHER_PROTOCOL;
  readonly providers: ReadonlySet<string>;
  preflight(input: WorkflowRuntimeInvocation): Promise<void>;
  dispatch(input: WorkflowRuntimeInvocation): Promise<WorkflowRuntimeTerminalResult>;
  reconcile(input: WorkflowRuntimeInvocation): Promise<WorkflowReconciliation>;
  resume(input: WorkflowRuntimeInvocation): Promise<WorkflowRuntimeTerminalResult>;
}

const intentSchema = z.object({
  schema_version: z.literal(WORKFLOW_DISPATCH_INTENT_SCHEMA_VERSION), dispatch_id: hash, invocation_hash: hash, plan_id: hash,
  model: z.string().trim().min(1), provider: z.string().trim().min(1), attempt: z.number().int().positive(), step_id: z.string().trim().min(1),
  workflow_sha256: hash, policy_sha256: hash,
}).strict();
type DispatchIntent = z.infer<typeof intentSchema>;
const recoveryIntentSchema = z.object({
  schema_version: z.literal(WORKFLOW_RECOVERY_INTENT_SCHEMA_VERSION), dispatch_id: hash, invocation_hash: hash, plan_id: hash,
  recovery_attempt: z.number().int().positive(),
}).strict();
const judgeIntentSchema = z.object({
  schema_version: z.literal(WORKFLOW_JUDGE_INTENT_SCHEMA_VERSION), judge_dispatch_id: hash, candidate_dispatch_id: hash,
  plan_id: hash, attempt: z.number().int().positive(), step_id: z.string().trim().min(1), judge_id: z.string().trim().min(1),
  judge_version: z.string().trim().min(1), model: z.string().trim().min(1), provider: z.string().trim().min(1), judge_policy_hash: hash,
}).strict();
type JudgeIntent = z.infer<typeof judgeIntentSchema>;
const retainedTerminalSchema = z.object({
  schema_version: z.literal(WORKFLOW_STEP_TERMINAL_SCHEMA_VERSION), dispatch_id: hash, invocation_hash: hash, plan_id: hash,
  model: z.string().trim().min(1), attempt: z.number().int().positive(), step_id: z.string().trim().min(1), recovered: z.boolean(), result: terminalSummary,
}).strict();
export type WorkflowStepTerminal = z.infer<typeof retainedTerminalSchema>;

export interface WorkflowRuntimeDryRun {
  readonly schema_version: 'juno_benchmark_workflow_dry_run.v1';
  readonly plan_id: `sha256:${string}`; readonly dispatch_count: 0; readonly order: readonly { readonly model: string; readonly attempt: number; readonly step_id: string; readonly dispatch_id: `sha256:${string}` }[];
  readonly production_models_sequential: true; readonly required_resources: readonly TypedResource[];
  readonly source: WorkflowExecutionPlan['source']; readonly selected_step_ids: readonly string[];
  readonly models: readonly string[]; readonly judge: WorkflowExecutionPlan['policy']['judge'];
  readonly injection_points: readonly { readonly model: string; readonly step_ids: readonly string[]; readonly workflow_sha256: string }[];
  readonly estimates: WorkflowExecutionPlan['policy']['estimates'] | null;
  readonly estimated_totals: { readonly usd: number; readonly runtime_ms: number } | null;
  readonly cost_tracking: { readonly mode: 'best_effort'; readonly unavailable_is_valid: true };
  readonly immutable_hashes: { readonly plan: string; readonly workflow_raw: string; readonly workflow_semantics: string; readonly policy_raw: string; readonly policy_semantics: string; readonly variables: string };
}
export interface WorkflowRuntimeOutcome { readonly plan_id: `sha256:${string}`; readonly terminals: readonly WorkflowStepTerminal[]; readonly recovered: boolean }
export interface WorkflowRuntimeOptions {
  readonly plan: WorkflowExecutionPlan; readonly projectRoot: string; readonly policyPath: string;
  readonly registry: ImmutableArtifactRegistry; readonly locks: PersistentTypedResourceLocks; readonly dispatcher?: TrustedWorkflowDispatcher;
  readonly judge?: GovernedWorkflowJudgeRunner; readonly dryRun?: boolean;
}

const execFileAsync = promisify(execFile);
async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, '--no-optional-locks', ...args], { encoding: 'utf8', timeout: 5_000, maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }); return stdout.trim();
}
function prefixed(bytes: Uint8Array): `sha256:${string}` { return `sha256:${sha256Hex(bytes)}`; }
function inside(root: string, candidate: string, label: string): string {
  const absolute = path.resolve(root, candidate); if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must remain inside the project root`); return absolute;
}
async function verifyImmediateBindings(options: WorkflowRuntimeOptions): Promise<void> {
  const plan = WorkflowExecutionPlanSchema.parse(options.plan); const root = path.resolve(options.projectRoot);
  if (plan.compiler_version !== WORKFLOW_COMPILER_VERSION) throw new Error('workflow compiler binding is unsupported');
  const workflowPath = inside(root, plan.source.workflow_path, 'workflow path'); const policyPath = inside(root, options.policyPath, 'workflow policy path');
  const [workflowRaw, policyRaw, sourceTree, committedRaw] = await Promise.all([
    readFile(workflowPath), readFile(policyPath), git(root, ['rev-parse', `${plan.source.source_commit}^{tree}`]),
    execFileAsync('git', ['-C', root, 'show', `${plan.source.source_commit}:${plan.source.workflow_path}`], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }).then((item) => Buffer.from(item.stdout)),
  ]);
  if (!workflowRaw.equals(committedRaw)) throw new Error('workflow working bytes drifted from the bound source commit');
  verifyWorkflowPlanBindings(plan, workflowRaw, policyRaw);
  if (sourceTree !== plan.snapshot.source_tree || canonicalHash({ repository_id: plan.source.repository_id, source_commit: plan.source.source_commit, source_tree: sourceTree }) !== plan.snapshot.identity) throw new Error('workflow snapshot binding drift detected');
  if (!plan.source.source_ref.startsWith('detached@') && await git(root, ['rev-parse', plan.source.source_ref]) !== plan.source.source_commit) throw new Error('workflow source ref drift detected');
  const configPath = inside(root, plan.workflow_model_policy.config_path, 'workflow model policy path'); let configRaw: Buffer | null = null;
  try { configRaw = await readFile(configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if ((configRaw === null ? null : prefixed(configRaw)) !== plan.workflow_model_policy.config_sha256) throw new Error('workflow model policy bytes drift detected');
  const models = configRaw === null ? [] : ((JSON.parse(configRaw.toString('utf8')) as { workflowModels?: unknown }).workflowModels ?? []);
  if (canonicalHash(models) !== plan.workflow_model_policy.workflow_models_sha256) throw new Error('workflow model allowlist drift detected');
  parseWorkflowPolicyBytes(policyRaw); // Same strict parser immediately before dispatch.
  for (const commandPolicy of plan.policy.deterministic_commands ?? []) {
    const scriptPath = inside(root, commandPolicy.script, 'deterministic tracked script path');
    const [workingScript, committedScript] = await Promise.all([
      readFile(scriptPath),
      execFileAsync('git', ['-C', root, 'show', `${plan.source.source_commit}:${commandPolicy.script}`], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }).then((item) => Buffer.from(item.stdout)),
    ]);
    if (!workingScript.equals(committedScript)) throw new Error(`deterministic tracked script drift detected: ${commandPolicy.script}`);
  }
}

function invocation(plan: WorkflowExecutionPlan, item: WorkflowExecutionPlan['execution_order'][number]): WorkflowRuntimeInvocation {
  const compiled = plan.compiled_workflows.find((entry) => entry.model === item.model)!; const policy = plan.policy.steps.find((entry) => entry.step_id === item.step_id)!;
  const core = { plan_id: plan.plan_id, model: item.model, provider: compiled.provider, attempt: item.attempt, step_id: item.step_id,
    workflow_sha256: compiled.workflow_sha256, variables_hash: plan.variables_hash, policy_sha256: plan.policy_semantics_sha256 };
  const dispatchId = canonicalHash(core); const invocationCore = { dispatch_id: dispatchId, plan_id: plan.plan_id as `sha256:${string}`,
    model: item.model, provider: compiled.provider, attempt: item.attempt, step_id: item.step_id, workflow_sha256: compiled.workflow_sha256 as `sha256:${string}`,
    workflow_bytes_base64: compiled.workflow_bytes_base64, variables: plan.variables, timeout_ms: policy.limits.timeout_ms,
    deterministic_command: plan.policy.deterministic_commands?.find((entry) => entry.step_id === item.step_id) ?? null };
  return Object.freeze({ ...invocationCore, invocation_hash: canonicalHash(invocationCore) });
}
function resourcesFor(plan: WorkflowExecutionPlan, stepId: string): TypedResource[] {
  const policy = plan.policy.steps.find((item) => item.step_id === stepId)!; return policy.resources.map((item) => ({ type: item.type, id: item.id }));
}
function experimentId(plan: WorkflowExecutionPlan): string { return `workflow-${plan.plan_id.slice(7)}`; }
async function appendJson(registry: ImmutableArtifactRegistry, experiment: string, role: string, value: unknown): Promise<void> {
  const reference = await registry.put(role, `${canonicalJson(value)}\n`); await registry.append(experiment, reference);
}
async function state(registry: ImmutableArtifactRegistry, plan: WorkflowExecutionPlan): Promise<{ intents: Map<string, DispatchIntent>; recoveryAttempts: Map<string, number>; judgeIntents: Map<string, JudgeIntent>; terminals: Map<string, WorkflowStepTerminal> }> {
  const intents = new Map<string, DispatchIntent>(); const recoveryAttempts = new Map<string, number>();
  const judgeIntents = new Map<string, JudgeIntent>(); const terminals = new Map<string, WorkflowStepTerminal>();
  for (const entry of await registry.verifyExperiment(experimentId(plan))) {
    if (!['workflow-dispatch-intent', 'workflow-recovery-intent', 'workflow-judge-intent', 'workflow-step-terminal'].includes(entry.role)) continue;
    const parsed = JSON.parse((await registry.read(entry as ArtifactReference)).toString('utf8')) as unknown;
    if (entry.role === 'workflow-dispatch-intent') { const value = intentSchema.parse(parsed); if (value.plan_id !== plan.plan_id || intents.has(value.dispatch_id)) throw new Error('workflow dispatch intent state is invalid'); intents.set(value.dispatch_id, value); }
    else if (entry.role === 'workflow-recovery-intent') {
      const value = recoveryIntentSchema.parse(parsed); const prior = recoveryAttempts.get(value.dispatch_id) ?? 0;
      if (value.plan_id !== plan.plan_id || value.recovery_attempt !== prior + 1) throw new Error('workflow recovery intent state is invalid');
      recoveryAttempts.set(value.dispatch_id, value.recovery_attempt);
    } else if (entry.role === 'workflow-judge-intent') { const value = judgeIntentSchema.parse(parsed); if (value.plan_id !== plan.plan_id || judgeIntents.has(value.judge_dispatch_id)) throw new Error('workflow judge intent state is invalid'); judgeIntents.set(value.judge_dispatch_id, value); }
    else { const value = retainedTerminalSchema.parse(parsed); if (value.plan_id !== plan.plan_id || terminals.has(value.dispatch_id)) throw new Error('workflow terminal state is invalid'); terminals.set(value.dispatch_id, value); }
  }
  return { intents, recoveryAttempts, judgeIntents, terminals };
}
function judgeIntentFor(plan: WorkflowExecutionPlan, input: WorkflowRuntimeInvocation,
  current: { readonly judgeIntents: Map<string, JudgeIntent> }): JudgeIntent {
  const judge = plan.policy.judge; const judgePolicyHash = canonicalHash(judge);
  const provider = judge.model.includes('/') ? judge.model.split('/')[0]! : 'governed';
  const judgeDispatchId = canonicalHash({ plan_id: plan.plan_id, candidate_dispatch_id: input.dispatch_id, attempt: input.attempt,
    step_id: input.step_id, judge_policy_hash: judgePolicyHash, purpose: 'judge' });
  if (current.judgeIntents.has(judgeDispatchId)) {
    throw new Error(`manual recovery required: prior governed judge dispatch has an ambiguous external effect for ${input.step_id}`);
  }
  return { schema_version: WORKFLOW_JUDGE_INTENT_SCHEMA_VERSION, judge_dispatch_id: judgeDispatchId,
    candidate_dispatch_id: input.dispatch_id, plan_id: plan.plan_id as `sha256:${string}`, attempt: input.attempt, step_id: input.step_id,
    judge_id: judge.judge_id, judge_version: judge.judge_version, model: judge.model, provider, judge_policy_hash: judgePolicyHash };
}
function validateResult(result: WorkflowRuntimeTerminalResult, input: WorkflowRuntimeInvocation): WorkflowRuntimeTerminalResult {
  const value = terminalResult.parse(result);
  if (value.dispatch_id !== input.dispatch_id || value.observed_provider !== input.provider || value.observed_model !== input.model) throw new Error('Workflow Runner/Juno terminal identity does not match the dispatch intent');
  if ((value.evidence.harness_validity.status === 'valid') !== (value.evidence.harness_validity.reason === null)) throw new Error('Workflow Runner/Juno harness validity is inconsistent');
  if (Date.parse(value.evidence.ended_at) < Date.parse(value.evidence.started_at)) throw new Error('Workflow Runner/Juno runtime evidence is invalid');
  return value;
}
function terminalSummaryValue(result: WorkflowRuntimeTerminalResult): z.infer<typeof terminalSummary> {
  return { dispatch_id: result.dispatch_id, status: result.status, effect: result.effect, runner_run_id: result.runner_run_id,
    observed_provider: result.observed_provider, observed_model: result.observed_model };
}
function terminalFromReceipt(receipt: WorkflowEvidenceReceipt, input: WorkflowRuntimeInvocation, plan: WorkflowExecutionPlan): WorkflowStepTerminal {
  if (receipt.plan_id !== plan.plan_id || receipt.policy_semantics_sha256 !== plan.policy_semantics_sha256
      || receipt.dispatch_id !== input.dispatch_id || receipt.invocation_hash !== input.invocation_hash
      || receipt.model !== input.model || receipt.attempt !== input.attempt || receipt.step_id !== input.step_id
      || receipt.identity.requested_provider !== input.provider || receipt.identity.requested_model !== input.model
      || receipt.identity.observed_provider !== input.provider || receipt.identity.observed_model !== input.model) {
    throw new Error('retained workflow receipt invocation binding is invalid');
  }
  return retainedTerminalSchema.parse({ schema_version: WORKFLOW_STEP_TERMINAL_SCHEMA_VERSION, dispatch_id: input.dispatch_id,
    invocation_hash: input.invocation_hash, plan_id: plan.plan_id, model: input.model, attempt: input.attempt, step_id: input.step_id, recovered: true,
    result: { dispatch_id: input.dispatch_id, status: receipt.candidate_outcome.status, effect: receipt.dispatch_recovery.effect,
      runner_run_id: receipt.dispatch_recovery.runner_run_id, observed_provider: receipt.identity.observed_provider, observed_model: receipt.identity.observed_model } });
}

export async function executeWorkflowPlan(options: WorkflowRuntimeOptions): Promise<WorkflowRuntimeDryRun | WorkflowRuntimeOutcome> {
  const plan = WorkflowExecutionPlanSchema.parse(options.plan); await verifyImmediateBindings(options);
  const invocations = plan.execution_order.map((item) => invocation(plan, item)); const allResources = plan.selected_step_ids.flatMap((id) => resourcesFor(plan, id));
  if (options.dryRun === true) return {
    schema_version: 'juno_benchmark_workflow_dry_run.v1', plan_id: plan.plan_id as `sha256:${string}`, dispatch_count: 0,
    order: invocations.map((item) => ({ model: item.model, attempt: item.attempt, step_id: item.step_id, dispatch_id: item.dispatch_id })),
    production_models_sequential: true, required_resources: [...new Map(allResources.map((item) => [`${item.type}\0${item.id}`, item])).values()],
    source: plan.source, selected_step_ids: plan.selected_step_ids, models: plan.models, judge: plan.policy.judge,
    injection_points: plan.compiled_workflows.map((item) => ({ model: item.model, step_ids: item.injected_step_ids, workflow_sha256: item.workflow_sha256 })),
    estimates: plan.policy.estimates ?? null,
    estimated_totals: plan.policy.estimates === undefined ? null : {
      usd: Math.round(plan.policy.estimates.models.reduce((total, item) => total + item.candidate_usd + item.judge_usd, 0) * 1_000_000) / 1_000_000,
      runtime_ms: plan.policy.estimates.models.reduce((total, item) => total + item.runtime_ms, 0),
    },
    cost_tracking: { mode: 'best_effort', unavailable_is_valid: true },
    immutable_hashes: { plan: plan.plan_id, workflow_raw: plan.source.raw_sha256, workflow_semantics: plan.source.semantics_sha256,
      policy_raw: plan.policy_raw_sha256, policy_semantics: plan.policy_semantics_sha256, variables: plan.variables_hash },
  };
  const dispatcher = options.dispatcher; if (dispatcher === undefined || dispatcher.protocol !== AUTH_LAUNCHER_PROTOCOL) throw new Error('workflow execution requires the trusted Juno credential launcher boundary');
  const judge = options.judge; if (judge === undefined) throw new Error('workflow execution requires the plan-bound governed judge');
  if (plan.compiled_workflows.some((item) => !dispatcher.providers.has(item.provider))) throw new Error('trusted launcher has no credential route for every exact provider');
  const terminals: WorkflowStepTerminal[] = []; let recovered = false; const experiment = experimentId(plan);
  const groups = new Map<string, WorkflowRuntimeInvocation[]>(); for (const item of invocations) { const key = `${item.model}\0${item.attempt}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
  // A plan identity has one process owner at a time. This closes the no-resource
  // race between state inspection and intent append without weakening typed
  // cross-plan exclusion for shared production resources.
  const planLease = await options.locks.acquire([{ type: 'workflow_plan', id: plan.plan_id }]);
  try { for (const group of groups.values()) {
    const production = group.some((item) => plan.policy.steps.find((policy) => policy.step_id === item.step_id)!.side_effect === 'production');
    const experimentResources: TypedResource[] = production ? [{ type: 'production', id: 'yylo-benchmark-model-experiment' }] : [];
    await options.locks.withResources(experimentResources, async () => {
      for (const input of group) {
        await options.locks.withResources(resourcesFor(plan, input.step_id), async () => {
          const current = await state(options.registry, plan); const retained = current.terminals.get(input.dispatch_id);
          if (retained !== undefined) {
            if (retained.invocation_hash !== input.invocation_hash) throw new Error('retained workflow terminal invocation binding is invalid');
            terminals.push(retained); recovered = true; return;
          }
          const existingReceipts = await readWorkflowEvidenceReceipts(options.registry, experiment);
          const retainedReceipts = existingReceipts.filter((receipt) => receipt.dispatch_id === input.dispatch_id);
          if (retainedReceipts.length > 1) throw new Error('duplicate retained workflow receipts are invalid');
          if (retainedReceipts.length === 1) {
            const terminal = terminalFromReceipt(retainedReceipts[0]!, input, plan);
            await appendJson(options.registry, experiment, 'workflow-step-terminal', terminal);
            terminals.push(terminal); recovered = true; return;
          }
          await dispatcher.preflight(input); // Credentials remain behind the reviewed boundary; cost is observational.
          let result: WorkflowRuntimeTerminalResult; let wasRecovered = false;
          let recoveryCount = current.recoveryAttempts.get(input.dispatch_id) ?? 0;
          const prior = current.intents.get(input.dispatch_id);
          if (prior === undefined) {
            const intent: DispatchIntent = { schema_version: WORKFLOW_DISPATCH_INTENT_SCHEMA_VERSION, dispatch_id: input.dispatch_id, invocation_hash: input.invocation_hash,
              plan_id: plan.plan_id as `sha256:${string}`, model: input.model, provider: input.provider, attempt: input.attempt, step_id: input.step_id,
              workflow_sha256: input.workflow_sha256, policy_sha256: plan.policy_semantics_sha256 };
            await appendJson(options.registry, experiment, 'workflow-dispatch-intent', intent); // Durable before consequential dispatch.
            result = validateResult(await dispatcher.dispatch(input), input);
          } else {
            if (prior.invocation_hash !== input.invocation_hash || prior.workflow_sha256 !== input.workflow_sha256 || prior.policy_sha256 !== plan.policy_semantics_sha256) throw new Error('workflow dispatch intent binding drift detected');
            const reconciliation = await dispatcher.reconcile(input); wasRecovered = true; recovered = true;
            if (reconciliation.state === 'terminal') result = validateResult(reconciliation.result, input);
            else if (reconciliation.state === 'ambiguous') throw new Error(`manual recovery required: ambiguous external effect for ${input.step_id}`);
            else {
              const policy = plan.policy.steps.find((item) => item.step_id === input.step_id)!;
              if (policy.recovery !== 'retry_safe') throw new Error(`manual recovery required: ${input.step_id} is not safely resumable`);
              const recoveryAttempt = recoveryCount + 1;
              if (recoveryAttempt > plan.policy.recovery.max_recovery_attempts) throw new Error(`manual recovery required: ${input.step_id} exhausted recovery attempts`);
              await appendJson(options.registry, experiment, 'workflow-recovery-intent', {
                schema_version: WORKFLOW_RECOVERY_INTENT_SCHEMA_VERSION, dispatch_id: input.dispatch_id,
                invocation_hash: input.invocation_hash, plan_id: plan.plan_id, recovery_attempt: recoveryAttempt,
              });
              recoveryCount = recoveryAttempt;
              result = validateResult(await dispatcher.resume(input), input);
            }
          }
          if (!existingReceipts.some((receipt) => receipt.dispatch_id === input.dispatch_id)) {
            const judgeIntent = judgeIntentFor(plan, input, await state(options.registry, plan));
            await retainAndGradeWorkflowStep({ registry: options.registry, experimentId: experiment, plan, dispatchId: input.dispatch_id,
              invocationHash: input.invocation_hash, model: input.model, provider: input.provider, attempt: input.attempt, stepId: input.step_id,
              observedProvider: result.observed_provider, observedModel: result.observed_model, runnerRunId: result.runner_run_id,
              effect: result.effect, recoveryCount, recovered: wasRecovered, evidence: result.evidence as WorkflowCandidateEvidence, judge,
              beforeJudgeDispatch: async () => appendJson(options.registry, experiment, 'workflow-judge-intent', judgeIntent) });
          }
          const terminal: WorkflowStepTerminal = { schema_version: WORKFLOW_STEP_TERMINAL_SCHEMA_VERSION, dispatch_id: input.dispatch_id, invocation_hash: input.invocation_hash,
            plan_id: plan.plan_id, model: input.model, attempt: input.attempt, step_id: input.step_id, recovered: wasRecovered, result: terminalSummaryValue(result) };
          await appendJson(options.registry, experiment, 'workflow-step-terminal', terminal); terminals.push(terminal);
        });
      }
    });
  } } finally { await planLease.release(); }
  return { plan_id: plan.plan_id as `sha256:${string}`, terminals: Object.freeze(terminals), recovered };
}

export const WORKFLOW_PROCESS_BOUNDARY_PROTOCOL = 'juno_benchmark_workflow_process_boundary.v1' as const;
const MAX_BOUNDARY_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_BOUNDARY_TIMEOUT_MS = 120_000;
const boundaryProbeResult = z.object({ schema_version: z.literal(WORKFLOW_PROCESS_BOUNDARY_PROTOCOL), providers: z.array(z.string().trim().min(1)).min(1) }).strict();
const boundaryPreflightResult = z.object({ ok: z.literal(true) }).strict();
const boundaryReconciliation = z.discriminatedUnion('state', [
  z.object({ state: z.literal('terminal'), result: terminalResult }).strict(),
  z.object({ state: z.enum(['safely_resumable', 'proven_not_dispatched', 'ambiguous']) }).strict(),
]);
const boundaryJudgeResult = z.object({ resolved: z.boolean(), evidence: z.string().trim().min(1) }).strict();

export interface ReviewedWorkflowBoundaryOptions {
  /** Absolute, canonical path to the reviewed self-contained JavaScript module. */
  readonly module: string;
  /** Lowercase SHA-256 of the exact module bytes. */
  readonly sha256: string;
  readonly timeoutMs?: number;
}
export interface ReviewedWorkflowBoundary {
  readonly dispatcher: TrustedWorkflowDispatcher;
  readonly judge: GovernedWorkflowJudgeRunner;
  readonly identity: { readonly protocol: typeof WORKFLOW_PROCESS_BOUNDARY_PROTOCOL; readonly sha256: `sha256:${string}` };
}

function boundaryDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function boundaryError(message: string): Error { return new Error(`reviewed workflow boundary rejected the request: ${message}`); }
async function reviewedBoundaryModule(options: ReviewedWorkflowBoundaryOptions): Promise<Buffer> {
  if (!path.isAbsolute(options.module) || !/^[0-9a-f]{64}$/u.test(options.sha256)) throw boundaryError('module identity is incomplete');
  const resolved = await realpath(options.module).catch(() => { throw boundaryError('module identity is missing'); });
  if (resolved !== options.module) throw boundaryError('module must be an exact non-symlinked path');
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw boundaryError('module cannot be opened safely'); });
  try {
    const before = await handle.stat();
    if (!before.isFile() || (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw boundaryError('module type or owner is invalid');
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw boundaryError('module identity changed while it was being pinned');
    }
    if (boundaryDigest(bytes) !== options.sha256) throw boundaryError('module identity digest does not match');
    return bytes;
  } finally { await handle.close(); }
}
async function invokeReviewedBoundary(
  bytes: Buffer,
  operation: 'probe' | 'preflight' | 'dispatch' | 'reconcile' | 'resume' | 'judge',
  input: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const child = spawn(process.execPath, ['--input-type=module', '-', operation, '--protocol', WORKFLOW_PROCESS_BOUNDARY_PROTOCOL], {
    env: { ...process.env, YYLO_BENCHMARK_WORKFLOW_PROTOCOL: WORKFLOW_PROCESS_BOUNDARY_PROTOCOL }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false,
  });
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let captured = 0; let overflow = false;
  const collect = (target: Buffer[]) => (chunk: Buffer): void => {
    captured += chunk.length;
    if (captured > MAX_BOUNDARY_OUTPUT_BYTES) { overflow = true; child.kill('SIGKILL'); }
    else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr)); child.stdin.end(bytes);
  (child.stdio[3] as NodeJS.WritableStream).end(`${JSON.stringify(input)}\n`);
  let timedOut = false; let force: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 1_000); }, timeoutMs);
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => { clearTimeout(timeout); if (force !== undefined) clearTimeout(force); });
  if (overflow) throw boundaryError(`${operation} output exceeded the bounded capture limit`);
  if (timedOut) throw boundaryError(`${operation} timed out`);
  // The reviewed module owns credentials that Benchmark deliberately cannot
  // inspect or scrub. Never reflect its stderr into public errors or receipts.
  if (closed.code !== 0 || closed.signal !== null) throw boundaryError(`${operation} failed with a nonzero or signalled terminal outcome`);
  try { return JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown; }
  catch { throw boundaryError(`${operation} returned malformed JSON`); }
}

export function workflowBoundaryOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ReviewedWorkflowBoundaryOptions | null {
  const module = environment['YYLO_BENCHMARK_WORKFLOW_BOUNDARY']?.trim();
  const sha256 = environment['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256']?.trim();
  const timeoutText = environment['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_TIMEOUT_MS']?.trim();
  if (module === undefined && sha256 === undefined && timeoutText === undefined) return null;
  if (module === undefined || module === '' || sha256 === undefined || sha256 === '') throw boundaryError('both module path and SHA-256 are required');
  let timeoutMs: number | undefined;
  if (timeoutText !== undefined) {
    timeoutMs = Number(timeoutText);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw boundaryError('timeout must be a positive integer');
  }
  return { module, sha256, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

export async function createReviewedWorkflowBoundary(options: ReviewedWorkflowBoundaryOptions): Promise<ReviewedWorkflowBoundary> {
  const bytes = await reviewedBoundaryModule(options); const timeoutMs = options.timeoutMs ?? DEFAULT_BOUNDARY_TIMEOUT_MS;
  const probe = boundaryProbeResult.parse(await invokeReviewedBoundary(bytes, 'probe', { schema_version: WORKFLOW_PROCESS_BOUNDARY_PROTOCOL }, timeoutMs));
  const providers = new Set(probe.providers);
  const operation = async <T>(name: 'preflight' | 'dispatch' | 'reconcile' | 'resume', input: WorkflowRuntimeInvocation,
    schema: z.ZodType<T>): Promise<T> => {
    if (!providers.has(input.provider)) throw boundaryError(`provider ${input.provider} is not advertised by the reviewed module`);
    const workflowBytes = Buffer.from(input.workflow_bytes_base64, 'base64');
    if (workflowBytes.toString('base64') !== input.workflow_bytes_base64 || prefixed(workflowBytes) !== input.workflow_sha256) {
      throw boundaryError('compiled workflow bytes do not match their exact invocation identity');
    }
    const invocationCore = { dispatch_id: input.dispatch_id, plan_id: input.plan_id, model: input.model, provider: input.provider,
      attempt: input.attempt, step_id: input.step_id, workflow_sha256: input.workflow_sha256,
      workflow_bytes_base64: input.workflow_bytes_base64, variables: input.variables, timeout_ms: input.timeout_ms,
      deterministic_command: input.deterministic_command };
    if (canonicalHash(invocationCore) !== input.invocation_hash) throw boundaryError('workflow invocation hash does not match its exact bytes');
    workflowStepRequiresModelDispatch(workflowBytes, input.step_id, input.deterministic_command ?? undefined); // Revalidate the exact command contract at the boundary.
    const operationTimeout = ['dispatch', 'resume'].includes(name) ? Math.max(timeoutMs, input.timeout_ms + 5_000) : timeoutMs;
    return schema.parse(await invokeReviewedBoundary(bytes, name, { invocation: input }, operationTimeout));
  };
  const dispatcher: TrustedWorkflowDispatcher = {
    protocol: AUTH_LAUNCHER_PROTOCOL, providers,
    preflight: async (input) => { await operation('preflight', input, boundaryPreflightResult); },
    dispatch: async (input) => operation('dispatch', input, terminalResult) as Promise<WorkflowRuntimeTerminalResult>,
    reconcile: async (input) => operation('reconcile', input, boundaryReconciliation) as Promise<WorkflowReconciliation>,
    resume: async (input) => operation('resume', input, terminalResult) as Promise<WorkflowRuntimeTerminalResult>,
  };
  const judge: GovernedWorkflowJudgeRunner = async (input) => boundaryJudgeResult.parse(
    await invokeReviewedBoundary(bytes, 'judge', { invocation: input }, timeoutMs),
  );
  return Object.freeze({ dispatcher, judge, identity: { protocol: WORKFLOW_PROCESS_BOUNDARY_PROTOCOL,
    sha256: `sha256:${options.sha256}` as `sha256:${string}` } });
}
