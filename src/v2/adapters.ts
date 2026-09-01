import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalHash, canonicalJson, sha256Hex, type JsonValue } from '../contracts/canonical.js';
import { AttemptEvidenceV2Schema, createAttemptPlan, normalizeCase, type AttemptEvidenceV2, type AttemptPlanV2 } from './contracts.js';
import { runHarnessAttempt, type HarnessAdapter, type HarnessRequest, type HarnessTerminalInput, type HarnessTerminalV2 } from './harness.js';
import { createAttemptWorkspace, publishAttemptWorkspaceResult, type AttemptWorkspaceV2 } from './workspace.js';
import type { PersistentTypedResourceLocks } from '../execution/resource-lock.js';
import { runCapturedProcess } from './process.js';

const execFileAsync = promisify(execFile);

interface CommonCompileInput {
  readonly sourceRepository: string;
  readonly baseCommit: string;
  readonly sourceIdentity: {
    readonly repository: string; readonly commit: string; readonly tree: string; readonly candidate_manifest_hash: `sha256:${string}`;
  };
  readonly experimentId: string;
  readonly attemptIndex: number;
  readonly harnessProfile: string;
  readonly requestedModel: string;
  readonly evaluators: AttemptPlanV2['evaluators'];
  readonly yyloVersion: string;
  readonly benchmarkVersion: string;
  readonly resources?: AttemptPlanV2['resources'];
}

export interface CompileTaskAttemptInput extends CommonCompileInput {
  readonly taskId: string;
  readonly taskVersion: string;
  readonly prompt: string;
  readonly variables?: Readonly<Record<string, JsonValue>>;
}

export interface CompileWorkflowAttemptInput extends CommonCompileInput {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowPath: string;
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly controlledModelVariable?: string;
  readonly selectedScope?: readonly string[];
}

function normalizedRelative(value: string, label: string): string {
  if (!value || path.posix.isAbsolute(value) || value.includes('\\') || value.split('/').some((item) => !item || item === '.' || item === '..')) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return value;
}

async function gitBlob(repository: string, commit: string, relative: string): Promise<Buffer> {
  normalizedRelative(relative, 'workflow path');
  try {
    const { stdout } = await execFileAsync('git', ['-C', repository, 'show', `${commit}:${relative}`], {
      encoding: 'buffer', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
    });
    return Buffer.from(stdout);
  } catch { throw new Error(`workflow must be tracked at the bound source commit: ${relative}`); }
}

export async function compileTaskAttempt(input: CompileTaskAttemptInput): Promise<AttemptPlanV2> {
  if (!input.prompt.trim()) throw new Error('task prompt must be non-empty');
  const caseValue = normalizeCase({
    kind: 'task', case_id: input.taskId, case_version: input.taskVersion,
    input: { prompt: input.prompt, variables: input.variables ?? {} }, source: input.sourceIdentity, yylo_version: input.yyloVersion,
  });
  return createAttemptPlan({ case: caseValue, experiment_id: input.experimentId, attempt_index: input.attemptIndex,
    harness_profile: input.harnessProfile, requested_model: input.requestedModel, workspace_backend: 'fresh_repository',
    evaluators: input.evaluators, yylo_version: input.yyloVersion, benchmark_version: input.benchmarkVersion,
    variables: input.variables ?? {}, resources: input.resources ?? [], comparison_kind: 'model_only' });
}

export async function compileWorkflowAttempt(input: CompileWorkflowAttemptInput): Promise<AttemptPlanV2> {
  const workflowPath = normalizedRelative(input.workflowPath, 'workflow path');
  const bytes = await gitBlob(input.sourceRepository, input.baseCommit, workflowPath);
  if (input.controlledModelVariable !== undefined && !(input.controlledModelVariable in input.variables)) {
    throw new Error(`controlled model variable is missing: ${input.controlledModelVariable}`);
  }
  const normalizedInput: Record<string, JsonValue> = {
    workflow_path: workflowPath,
    workflow_sha256: `sha256:${sha256Hex(bytes)}`,
    variables: input.variables,
    selected_scope: [...(input.selectedScope ?? [])],
    controlled_model_variable: input.controlledModelVariable ?? null,
  };
  const caseValue = normalizeCase({ kind: 'workflow', case_id: input.workflowId, case_version: input.workflowVersion,
    input: normalizedInput, source: input.sourceIdentity, yylo_version: input.yyloVersion });
  return createAttemptPlan({ case: caseValue, experiment_id: input.experimentId, attempt_index: input.attemptIndex,
    harness_profile: input.harnessProfile, requested_model: input.requestedModel, workspace_backend: 'fresh_repository',
    evaluators: input.evaluators, yylo_version: input.yyloVersion, benchmark_version: input.benchmarkVersion,
    variables: input.variables, resources: input.resources ?? [],
    comparison_kind: input.controlledModelVariable === undefined ? 'agent_system' : 'model_only' });
}

export function caseInvocation(plan: AttemptPlanV2): JsonValue {
  const normalized = plan.case.normalized_input;
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) throw new Error('case normalized input is malformed');
  if (plan.case.kind === 'task') return { kind: 'task', prompt: normalized['prompt'] ?? null, variables: normalized['variables'] ?? {} };
  if (plan.case.kind === 'workflow') return {
    kind: 'workflow', workflow_path: normalized['workflow_path'] ?? null,
    workflow_sha256: normalized['workflow_sha256'] ?? null, variables: normalized['variables'] ?? {},
    selected_scope: normalized['selected_scope'] ?? [],
  };
  return { kind: 'custom', input: normalized };
}

export function nonModelInputHash(plan: AttemptPlanV2): `sha256:${string}` {
  const original = plan.case.normalized_input;
  let controlled: string | null = null;
  let normalized = original;
  if (typeof original === 'object' && original !== null && !Array.isArray(original)) {
    controlled = typeof original['controlled_model_variable'] === 'string' ? original['controlled_model_variable'] : null;
    const originalVariables = original['variables'];
    const filteredVariables = typeof originalVariables === 'object' && originalVariables !== null && !Array.isArray(originalVariables) && controlled !== null
      ? Object.fromEntries(Object.entries(originalVariables).filter(([key]) => key !== controlled)) : originalVariables;
    normalized = { ...original, variables: filteredVariables ?? {} };
  }
  const variables = controlled === null ? { ...plan.variables }
    : Object.fromEntries(Object.entries(plan.variables).filter(([key]) => key !== controlled));
  return canonicalHash({ case_kind: plan.case.kind, case_version: plan.case.case_version, input: normalized,
    source_tree: plan.case.source.tree, harness_profile: plan.harness_profile, variables, resources: plan.resources, evaluators: plan.evaluators });
}

export interface ExecuteCaseAttemptOptions {
  readonly plan: AttemptPlanV2;
  readonly sourceRepository: string;
  readonly attemptsRoot: string;
  readonly privateRegistryRoot: string;
  readonly intentRoot: string;
  readonly adapter: HarnessAdapter;
  readonly excludedPaths?: readonly string[];
  readonly controllerPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly locks?: PersistentTypedResourceLocks;
}

export interface ExecutedCaseAttempt {
  readonly plan: AttemptPlanV2;
  readonly workspace: AttemptWorkspaceV2;
  readonly terminal: HarnessTerminalV2;
  readonly evidence: AttemptEvidenceV2;
}

export function evidenceFromTerminal(plan: AttemptPlanV2, workspace: AttemptWorkspaceV2, terminal: HarnessTerminalV2): AttemptEvidenceV2 {
  const now = new Date().toISOString();
  const status = terminal.terminal_status === 'ambiguous' || terminal.validity === 'invalid' ? 'invalid' : terminal.terminal_status;
  const core = {
    schema_version: 'yylo_benchmark_attempt_evidence.v2' as const,
    yylo_version: plan.yylo_version,
    benchmark_version: plan.benchmark_version,
    attempt_id: plan.attempt_id,
    plan_hash: plan.plan_hash,
    candidate: {
      status, exit_code: terminal.exit_code, signal: terminal.signal, session_id: terminal.session_id,
      started_at: terminal.started_at ?? now, ended_at: terminal.ended_at ?? now,
      runtime_ms: terminal.runtime_ms ?? 0, cost: terminal.cost, output: boundedOutput(terminal.raw_output),
      validity: terminal.validity, diagnostics: terminal.diagnostics,
    },
    identity: {
      harness_profile: terminal.harness_profile, requested_model: terminal.requested_model,
      resolved_provider: terminal.resolved_provider, resolved_model: terminal.resolved_model,
      observed_provider: terminal.observed_provider, observed_model: terminal.observed_model,
      observed_harness_version: terminal.observed_harness_version,
    },
    workspace_receipt_hash: workspace.receipt.receipt_hash,
    workspace_manifest_hash: terminal.workspace_manifest_hash,
    artifacts: terminal.artifacts,
  };
  return AttemptEvidenceV2Schema.parse({ ...core, evidence_hash: canonicalHash(core) });
}

function boundedOutput(value: string | null): string | null {
  if (value === null) return null;
  const bytes = Buffer.from(value);
  if (bytes.length <= 1024 * 1024) return value;
  return `${bytes.subarray(0, 1024 * 1024 - 24).toString('utf8')}\n[TRUNCATED BY POLICY]`;
}

async function dispatch(plan: AttemptPlanV2, workspace: AttemptWorkspaceV2, intentRoot: string, adapter: HarnessAdapter): Promise<HarnessTerminalV2> {
  return runHarnessAttempt({ attemptId: plan.attempt_id as `sha256:${string}`, requestedModel: plan.requested_model, cwd: workspace.repository,
    environment: workspace.candidateEnvironment, invocation: caseInvocation(plan), intentRoot, adapter, deniedPaths: workspace.deniedPaths,
    publishWorkspaceResult: async () => (await publishAttemptWorkspaceResult(workspace)).manifest_hash });
}

export async function executeCaseAttempt(options: ExecuteCaseAttemptOptions): Promise<ExecutedCaseAttempt> {
  if (options.plan.workspace_backend !== 'fresh_repository') throw new Error('this executor requires the fresh_repository workspace backend');
  const workspace = await createAttemptWorkspace({ attemptId: options.plan.attempt_id as `sha256:${string}`, sourceRepository: options.sourceRepository,
    baseCommit: options.plan.case.source.commit, attemptsRoot: options.attemptsRoot, privateRegistryRoot: options.privateRegistryRoot,
    excludedPaths: ['.juno_task', 'hidden-graders', 'reference-solutions', ...(options.excludedPaths ?? [])],
    ...(options.controllerPaths === undefined ? {} : { controllerPaths: options.controllerPaths }),
    ...(options.deniedPaths === undefined ? {} : { deniedPaths: options.deniedPaths }) });
  if (workspace.receipt.source_commit !== options.plan.case.source.commit
      || workspace.receipt.source_tree !== options.plan.case.source.tree
      || workspace.snapshot.source_commit !== options.plan.case.source.commit
      || workspace.snapshot.source_tree !== options.plan.case.source.tree) {
    throw new Error('attempt workspace receipt/source identity mismatch before candidate dispatch');
  }
  const run = async () => dispatch(options.plan, workspace, options.intentRoot, options.adapter);
  const lockedResources = options.plan.resources.filter((item) => item.access !== 'read').map(({ type, id }) => ({ type, id }));
  const terminal = options.locks === undefined ? await run() : await options.locks.withResources(lockedResources, run);
  return Object.freeze({ plan: options.plan, workspace, terminal, evidence: evidenceFromTerminal(options.plan, workspace, terminal) });
}

export async function recoverCaseAttempt(options: {
  readonly plan: AttemptPlanV2; readonly workspace: AttemptWorkspaceV2; readonly intentRoot: string; readonly adapter: HarnessAdapter;
}): Promise<HarnessTerminalV2> {
  return dispatch(options.plan, options.workspace, options.intentRoot, options.adapter);
}

export interface WorkflowRunnerHarnessOptions {
  readonly profileId?: string;
  readonly executable: string;
  readonly timeoutMs?: number;
  readonly extraArgs?: readonly string[];
}

/** Workflow Runner owns YAML interpretation; Benchmark forwards the tracked file and variables unchanged. */
export class WorkflowRunnerHarnessAdapter implements HarnessAdapter {
  public readonly profileId: string;
  public readonly version = '2';
  readonly #executable: string; readonly #timeoutMs: number; readonly #extraArgs: readonly string[];
  public constructor(options: WorkflowRunnerHarnessOptions) {
    this.profileId = options.profileId ?? 'yylo-workflow-runner'; this.#executable = options.executable; this.#timeoutMs = options.timeoutMs ?? 60 * 60 * 1000; this.#extraArgs = options.extraArgs ?? [];
  }
  public async probe(): Promise<{ ready: true }> { return { ready: true }; }
  public async prepare(request: HarnessRequest): Promise<{ prepared: boolean; reason?: string }> {
    const invocation = workflowInvocation(request);
    try { await readFile(path.join(request.cwd, invocation.workflow_path)); return { prepared: true }; }
    catch { return { prepared: false, reason: 'tracked workflow is absent from the attempt workspace' }; }
  }
  public async reconcile(): Promise<{ state: 'ambiguous'; reason: string }> {
    return { state: 'ambiguous', reason: 'Workflow Runner terminal is absent; use its supported recovery receipt or reconcile manually' };
  }
  public async run(request: HarnessRequest): Promise<HarnessTerminalInput> {
    const invocation = workflowInvocation(request);
    const args = ['--workflow', invocation.workflow_path, ...Object.entries(invocation.variables).flatMap(([key, value]) => ['--var', `${key}=${workflowVariable(value)}`]), ...this.#extraArgs];
    const started = new Date();
    const result = await runCapturedProcess(this.#executable, args, { cwd: request.cwd, environment: request.environment,
      timeoutMs: request.timeoutMs ?? this.#timeoutMs, ...(request.deniedPaths === undefined ? {} : { deniedPaths: request.deniedPaths }) });
    const ended = new Date(); const output = `${result.stdout}${result.stderr}`;
    const sessionId = output.match(/(?:session[_ ]id|Session ID)[:= ]+([A-Za-z0-9._:-]+)/iu)?.[1] ?? null;
    return { status: result.timedOut ? 'timeout' : result.signal !== null ? 'failure' : result.code === 0 ? 'success' : 'failure',
      exit_code: result.code, signal: result.signal, session_id: sessionId,
      resolved_provider: 'workflow-runner', resolved_model: request.requestedModel,
      observed_provider: 'workflow-runner', observed_model: request.requestedModel, harness_version: this.version,
      started_at: started.toISOString(), ended_at: ended.toISOString(), runtime_ms: ended.getTime() - started.getTime(),
      cost: { completeness: 'unavailable', usd: null }, process: { pid: result.pid, command: [this.#executable, ...args] }, artifacts: [], raw_output: `${result.stdout}${result.stderr}` };
  }
}

function workflowVariable(value: JsonValue): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

function workflowInvocation(request: HarnessRequest): { workflow_path: string; variables: Record<string, JsonValue> } {
  const invocation = request.invocation;
  if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation) || invocation['kind'] !== 'workflow'
      || typeof invocation['workflow_path'] !== 'string' || typeof invocation['variables'] !== 'object' || invocation['variables'] === null || Array.isArray(invocation['variables'])) {
    throw new Error('workflow harness requires a workflow invocation');
  }
  return { workflow_path: normalizedRelative(invocation['workflow_path'], 'workflow path'), variables: invocation['variables'] };
}
