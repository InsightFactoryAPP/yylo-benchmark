import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalHash, canonicalJson, sha256Hex } from '../contracts/canonical.js';
import { AttemptV1Schema, NormalizedResultV1Schema, type AttemptV1, type NormalizedResultV1 } from '../contracts/schemas.js';
import type { PublicKanbanClient, RevisionedTask } from '../kanban/client.js';
import { acceptPlan, validatePlanModelBindings, type ExecutionPlan, type RecordPolicy } from '../planning/index.js';
import { ImmutableArtifactRegistry, type ArtifactReference, type ManifestEntry } from '../registry/index.js';
import { sanitizeCandidateEnvironment } from '../shadow-kanban/index.js';
import { reconcileJunoTelemetry, type ProcessEvidence } from '../telemetry/index.js';
import { gradeRetainedAttempt, verifyRequiredGraderReceipt, type GraderRunner } from '../grading/index.js';

export interface PreparedAttempt {
  readonly repository: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly shadowHash: `sha256:${string}`;
  /** Immutable synthetic baseline created by the snapshot builder. */
  readonly baselineCommit: string;
  readonly baselineTree: string;
}
export interface CandidateInvocation {
  readonly attempt: AttemptV1;
  readonly repository: string;
  readonly prompt: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}
export type CandidateRunner = ((input: CandidateInvocation) => Promise<ProcessEvidence>) & {
  /** Admission hook runs before the durable dispatch marker and any paid operation. */
  preflight?: (input: CandidateInvocation) => Promise<void>;
};
export interface RunExperimentOptions {
  readonly client: PublicKanbanClient;
  readonly registry: ImmutableArtifactRegistry;
  readonly plan: ExecutionPlan;
  readonly prepareAttempt: (attempt: AttemptV1) => Promise<PreparedAttempt>;
  readonly runner: CandidateRunner;
  readonly grader?: GraderRunner | undefined;
  readonly recordPolicy?: RecordPolicy;
  readonly timeoutMs?: number;
}
export interface AttemptOutcome { readonly attempt: AttemptV1; readonly result: NormalizedResultV1; readonly provider: string; readonly recovered: boolean }
export interface ExperimentOutcome { readonly experimentTaskId: string | null; readonly attempts: readonly AttemptOutcome[]; readonly recovered: boolean }

function experimentKey(plan: ExecutionPlan): string { return plan.plan_id.slice('sha256:'.length); }
function attemptId(plan: ExecutionPlan, model: string, ordinal: number): string {
  return canonicalHash({ schema_version: 'juno_benchmark_attempt_identity.v1', plan_id: plan.plan_id, model, ordinal }).slice('sha256:'.length);
}
function contract(plan: ExecutionPlan, model: string, ordinal: number): AttemptV1 {
  return AttemptV1Schema.parse({
    schema_version: 'juno_benchmark_attempt.v1', attempt_id: attemptId(plan, model, ordinal), experiment_id: plan.plan_id,
    case_input_hash: plan.case.input_hash, snapshot_hash: plan.snapshot_hash, prompt_hash: plan.case.prompt_hash,
    agent: 'juno-code', provider: model.includes('/') ? model.split('/')[0] : 'configured', model,
    tool_policy_hash: plan.tool_policy_hash, budget_hash: plan.budget_hash,
    package_version: plan.package_version, juno_version: plan.juno_version, session_topology: 'fresh',
  });
}
async function jsonArtifact(registry: ImmutableArtifactRegistry, role: string, value: unknown): Promise<ArtifactReference> {
  return registry.put(role, `${canonicalJson(value)}\n`);
}
async function appendOnce(registry: ImmutableArtifactRegistry, id: string, reference: ArtifactReference): Promise<void> {
  const entries = await registry.verifyExperiment(id);
  if (!entries.some((entry) => entry.role === reference.role && entry.sha256 === reference.sha256)) await registry.append(id, reference);
}
async function resultsByAttempt(registry: ImmutableArtifactRegistry, id: string): Promise<Map<string, NormalizedResultV1>> {
  const found = new Map<string, NormalizedResultV1>();
  const entries = await registry.verifyExperiment(id);
  for (const entry of entries) {
    if (entry.role !== 'normalized-result') continue;
    const result = NormalizedResultV1Schema.parse(JSON.parse((await registry.read(entry)).toString('utf8')) as unknown);
    found.set(result.attempt_id, result);
  }
  for (const [attemptId, result] of found) {
    if (result.resolved || result.terminal_class === 'grader_failure') await verifyRequiredGraderReceipt(registry, entries, attemptId);
  }
  return found;
}
async function dispatchedAttempts(registry: ImmutableArtifactRegistry, id: string): Promise<Set<string>> {
  const result = new Set<string>();
  for (const entry of await registry.verifyExperiment(id)) {
    if (entry.role !== 'attempt-dispatched') continue;
    const value = JSON.parse((await registry.read(entry)).toString('utf8')) as { attempt_id?: unknown };
    if (typeof value.attempt_id !== 'string') throw new Error('invalid dispatch marker');
    result.add(value.attempt_id);
  }
  return result;
}

async function gitCommand(repository: string, args: readonly string[], extraEnvironment: NodeJS.ProcessEnv = {}, input?: Buffer): Promise<Buffer> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => !name.startsWith('GIT_') && value !== undefined));
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-C', repository, '--no-optional-locks', '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', ...args], {
      env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C', LANG: 'C', ...extraEnvironment },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell: false,
    });
    const output: Buffer[] = []; const error: Buffer[] = [];
    if (input !== undefined) child.stdin?.end(input);
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk)); child.stderr?.on('data', (chunk: Buffer) => error.push(chunk));
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(error).toString('utf8')}`)));
  });
}

async function capturedWorktreeEntries(repository: string): Promise<Array<{ mode: '100644' | '100755' | '120000'; path: string; bytes: Buffer }>> {
  const entries: Array<{ mode: '100644' | '100755' | '120000'; path: string; bytes: Buffer }> = [];
  async function visit(relative: string): Promise<void> {
    const absolute = relative === '' ? repository : path.join(repository, ...relative.split('/'));
    for (const name of (await readdir(absolute)).sort()) {
      if (name.includes('\0')) throw new Error('candidate worktree contains an unsupported NUL path');
      const child = relative === '' ? name : `${relative}/${name}`;
      // .git and .juno_task are harness-owned. The latter contains the shadow
      // board plus candidate HOME/XDG/cache state and is retained separately,
      // never as candidate product output.
      if (relative === '' && (name === '.git' || name === '.juno_task')) continue;
      if (name === '.git') throw new Error(`candidate worktree contains nested repository metadata at ${child}`);
      const full = path.join(repository, ...child.split('/'));
      const metadata = await lstat(full);
      if (metadata.isDirectory()) await visit(child);
      else if (metadata.isSymbolicLink()) entries.push({ mode: '120000', path: child, bytes: Buffer.from(await readlink(full)) });
      else if (metadata.isFile()) entries.push({ mode: (metadata.mode & 0o111) !== 0 ? '100755' : '100644', path: child, bytes: await readFile(full) });
      else throw new Error(`candidate worktree contains unsupported special file at ${child}`);
    }
  }
  await visit('');
  return entries;
}

async function gitPatch(repository: string, baselineCommit: string, baselineTree: string): Promise<Buffer> {
  const head = (await gitCommand(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
  const tree = (await gitCommand(repository, ['rev-parse', '--verify', `${baselineCommit}^{tree}`])).toString('utf8').trim();
  if (head !== baselineCommit || tree !== baselineTree) throw new Error('candidate mutated the manifest-bound synthetic Git baseline');

  // Never trust the candidate's index, attributes, ignore metadata, or clean
  // filters. Hash exact filesystem bytes into a private index without --path.
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-patch-'));
  const capturedIndex = path.join(temporary, 'captured.index');
  const verifiedIndex = path.join(temporary, 'verified.index');
  try {
    const capturedEnvironment = { GIT_INDEX_FILE: capturedIndex };
    await gitCommand(repository, ['read-tree', '--empty'], capturedEnvironment);
    for (const entry of await capturedWorktreeEntries(repository)) {
      const oid = (await gitCommand(repository, ['hash-object', '-w', '--stdin'], {}, entry.bytes)).toString('utf8').trim();
      await gitCommand(repository, ['update-index', '--add', '--cacheinfo', `${entry.mode},${oid},${entry.path}`], capturedEnvironment);
    }
    const capturedTree = (await gitCommand(repository, ['write-tree'], capturedEnvironment)).toString('utf8').trim();
    const patch = await gitCommand(repository, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', baselineCommit, '--'], capturedEnvironment);

    if (patch.length === 0) {
      if (capturedTree !== baselineTree) throw new Error('empty captured patch does not reproduce the exact final worktree tree');
      return patch;
    }

    const verifiedEnvironment = { GIT_INDEX_FILE: verifiedIndex };
    await gitCommand(repository, ['read-tree', baselineCommit], verifiedEnvironment);
    await gitCommand(repository, ['apply', '--cached', '--index', '--binary', '--whitespace=nowarn', '-'], verifiedEnvironment, patch);
    const reproducedTree = (await gitCommand(repository, ['write-tree'], verifiedEnvironment)).toString('utf8').trim();
    if (reproducedTree !== capturedTree) throw new Error('captured patch does not reproduce the exact final worktree tree');
    return patch;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function recoveryFailure(item: AttemptV1, at: string): NormalizedResultV1 {
  const evidence = { schema_version: 'juno_benchmark_recovery_terminal.v1', attempt_id: item.attempt_id, reason: 'dispatch marker exists without durable terminal evidence; refusing paid redispatch' };
  return NormalizedResultV1Schema.parse({ schema_version: 'juno_benchmark_normalized_result.v1', attempt_id: item.attempt_id, resolved: false,
    terminal_class: 'harness_failure', session_id: null, started_at: at, ended_at: at, elapsed_ms: 0,
    cost: { completeness: 'unavailable', usd: null }, patch_hash: null, terminal_evidence_hash: canonicalHash(evidence) });
}

async function locateRecord(client: PublicKanbanClient, plan: ExecutionPlan, acceptedTaskId: string | undefined): Promise<RevisionedTask | null> {
  if (acceptedTaskId !== undefined) return client.getRevisionedTask(acceptedTaskId);
  return client.findRelatedRecord({ kind: 'experiment', sourceTaskId: plan.case.task_id, recordId: plan.plan_id });
}

async function updateCanonicalIndex(options: Pick<RunExperimentOptions, 'client' | 'registry' | 'plan'>, record: RevisionedTask, outcomes: readonly AttemptOutcome[], entries: readonly ManifestEntry[]): Promise<RevisionedTask> {
  const previous = record.task.fields['benchmark'];
  if (typeof previous !== 'object' || previous === null) throw new Error('canonical experiment benchmark field is invalid');
  const attempts = outcomes.map(({ attempt, result, provider }) => ({
    attempt_id: attempt.attempt_id, model: attempt.model, provider, terminal_class: result.terminal_class,
    resolved: result.resolved, session_id: result.session_id, elapsed_ms: result.elapsed_ms, cost: result.cost,
    patch_hash: result.patch_hash, terminal_evidence_hash: result.terminal_evidence_hash,
  }));
  const evidence = entries.map(({ role, backend, path: retainedPath, size, sha256 }) => ({ role, backend, path: retainedPath, size, sha256 }));
  const updated = await options.client.updateBenchmarkField(record.task.id, record.revision, {
    ...(previous as Record<string, unknown>), status: 'terminal', attempts,
    resolved_count: attempts.filter((item) => item.resolved).length, evidence,
  });
  const receipt = await jsonArtifact(options.registry, 'kanban-mutation-receipt', updated.receipt);
  await appendOnce(options.registry, experimentKey(options.plan), receipt);
  return { task: updated.task, revision: updated.receipt.after_sha256 };
}

/** Execute each immutable attempt once. A durable dispatch marker forbids automatic redispatch after a crash. */
export async function runExperiment(options: RunExperimentOptions): Promise<ExperimentOutcome> {
  const accepted = await acceptPlan(options.client, options.registry, options.plan, options.recordPolicy);
  const source = await options.client.getRevisionedTask(options.plan.case.task_id);
  if (source.revision !== options.plan.case.task_revision) throw new Error('benchmark case changed after plan acceptance');
  const key = experimentKey(options.plan);
  const existing = await resultsByAttempt(options.registry, key); const dispatched = await dispatchedAttempts(options.registry, key);
  const outcomes: AttemptOutcome[] = [];
  for (const model of options.plan.models) for (let ordinal = 1; ordinal <= options.plan.attempts; ordinal += 1) {
    const item = contract(options.plan, model, ordinal); const terminal = existing.get(item.attempt_id);
    if (terminal !== undefined) { outcomes.push({ attempt: item, result: terminal, provider: item.provider, recovered: true }); continue; }
    const contractReference = await jsonArtifact(options.registry, 'attempt-contract', item); await appendOnce(options.registry, key, contractReference);
    if (dispatched.has(item.attempt_id)) {
      const at = new Date().toISOString(); const result = recoveryFailure(item, at);
      const terminalEvidence = await jsonArtifact(options.registry, 'structured-juno-evidence', { attempt_id: item.attempt_id, reason: 'indeterminate_after_dispatch' });
      const resultReference = await jsonArtifact(options.registry, 'normalized-result', result);
      await appendOnce(options.registry, key, terminalEvidence); await appendOnce(options.registry, key, resultReference);
      outcomes.push({ attempt: item, result, provider: item.provider, recovered: true }); continue;
    }
    const prepared = await options.prepareAttempt(item);
    if (prepared.snapshotHash !== options.plan.snapshot_hash) throw new Error(`prepared snapshot does not match plan for ${item.attempt_id}`);
    const invocation = { attempt: item, repository: prepared.repository, prompt: source.task.body, environment: sanitizeCandidateEnvironment(process.env, prepared.repository), timeoutMs: options.timeoutMs ?? 30 * 60_000 };
    // Credential source and immutable launcher identity must be admitted before
    // recording dispatch. A rejected boundary can therefore be retried safely
    // without ever duplicating a paid attempt.
    await options.runner.preflight?.(invocation);
    const dispatch = await jsonArtifact(options.registry, 'attempt-dispatched', { schema_version: 'juno_benchmark_dispatch.v1', attempt_id: item.attempt_id, snapshot_hash: prepared.snapshotHash, shadow_hash: prepared.shadowHash });
    await appendOnce(options.registry, key, dispatch);
    let processEvidence: ProcessEvidence;
    try {
      processEvidence = await options.runner(invocation);
    } catch (error) {
      const at = new Date().toISOString();
      processEvidence = { attemptId: item.attempt_id, expectedModel: item.model, expectedJunoVersion: item.juno_version,
        startedAt: at, endedAt: at, elapsedMs: 0, exitCode: null, signal: null,
        stdout: `${canonicalJson({ terminal_class: 'environment_failure', error: error instanceof Error ? error.message : String(error) })}\n`, stderr: '', patchHash: null };
    }
    const patch = await gitPatch(prepared.repository, prepared.baselineCommit, prepared.baselineTree); const patchReference = await options.registry.put('patch', patch);
    // Expected identity is controller-owned attempt truth. A candidate runner may
    // report observations but cannot replace the planned comparison target.
    const patchedEvidence = { ...processEvidence, attemptId: item.attempt_id, expectedModel: item.model,
      expectedJunoVersion: item.juno_version, patchHash: patchReference.sha256 };
    const reconciled = reconcileJunoTelemetry(patchedEvidence);
    const stdout = await options.registry.put('stdout', processEvidence.stdout); const stderr = await options.registry.put('stderr', processEvidence.stderr);
    const evidenceReference = await options.registry.put('structured-juno-evidence', canonicalJson(reconciled.evidence));
    if (evidenceReference.sha256 !== reconciled.result.terminal_evidence_hash) throw new Error('terminal evidence hash reconciliation failed');
    const candidateReference = await jsonArtifact(options.registry, 'candidate-result', reconciled.result);
    for (const reference of [stdout, stderr, patchReference, evidenceReference, candidateReference]) await appendOnce(options.registry, key, reference);
    const graded = await gradeRetainedAttempt({ registry: options.registry, experimentId: key, attempt: item,
      profile: options.plan.case.case_ref.grader_profile, candidateResult: reconciled.result,
      candidateSucceeded: reconciled.candidateSucceeded, runner: options.grader });
    const resultReference = await jsonArtifact(options.registry, 'normalized-result', graded);
    await appendOnce(options.registry, key, resultReference);
    outcomes.push({ attempt: item, result: graded, provider: reconciled.provider, recovered: false });
  }
  const canonical = await locateRecord(options.client, options.plan, accepted.record?.task.id);
  const indexed = canonical?.task.fields['benchmark'] as { status?: unknown } | undefined;
  if (canonical !== null && !(outcomes.every((item) => item.recovered) && indexed?.status === 'terminal')) {
    await updateCanonicalIndex(options, canonical, outcomes, await options.registry.verifyExperiment(key));
  }
  return { experimentTaskId: canonical?.task.id ?? null, attempts: outcomes, recovered: accepted.recovered || outcomes.some((item) => item.recovered) };
}

/** Re-run governed grading from retained candidate artifacts; no candidate runner or workspace is accepted. */
export async function regradeExperiment(options: {
  readonly registry: ImmutableArtifactRegistry; readonly plan: ExecutionPlan; readonly grader?: GraderRunner | undefined;
  readonly client?: PublicKanbanClient;
}): Promise<readonly NormalizedResultV1[]> {
  const key = experimentKey(options.plan); const entries = await options.registry.verifyExperiment(key);
  const attempts = new Map<string, AttemptV1>(); const candidates = new Map<string, NormalizedResultV1>();
  const success = new Map<string, boolean>();
  for (const entry of entries) {
    const value = entry.role === 'attempt-contract' || entry.role === 'candidate-result' || entry.role === 'structured-juno-evidence'
      ? JSON.parse((await options.registry.read(entry)).toString('utf8')) as Record<string, unknown> : null;
    if (entry.role === 'attempt-contract' && value !== null) { const item = AttemptV1Schema.parse(value); attempts.set(item.attempt_id, item); }
    if (entry.role === 'candidate-result' && value !== null) { const item = NormalizedResultV1Schema.parse(value); candidates.set(item.attempt_id, item); }
    if (entry.role === 'structured-juno-evidence' && value !== null && typeof value['attempt_id'] === 'string') {
      const envelope = value['envelope'] as { status?: unknown } | null; success.set(value['attempt_id'], envelope?.status === 'success' && value['exit_code'] === 0);
    }
  }
  const results: NormalizedResultV1[] = []; const outcomes: AttemptOutcome[] = [];
  for (const [attemptId, attempt] of attempts) {
    const candidate = candidates.get(attemptId); if (candidate === undefined) throw new Error(`candidate evidence missing for ${attemptId}`);
    const graded = await gradeRetainedAttempt({ registry: options.registry, experimentId: key, attempt,
      profile: options.plan.case.case_ref.grader_profile, candidateResult: candidate,
      candidateSucceeded: success.get(attemptId) === true, runner: options.grader });
    const reference = await jsonArtifact(options.registry, 'normalized-result', graded); await appendOnce(options.registry, key, reference); results.push(graded);
    outcomes.push({ attempt, result: graded, provider: attempt.provider, recovered: true });
  }
  if (options.client !== undefined) {
    const record = await locateRecord(options.client, options.plan, undefined);
    if (record === null) throw new Error('canonical experiment record is missing for regrade');
    await updateCanonicalIndex({ client: options.client, registry: options.registry, plan: options.plan }, record, outcomes, await options.registry.verifyExperiment(key));
  }
  return Object.freeze(results);
}

export interface SpawnJunoOptions { readonly executable?: string; readonly leadingArguments?: readonly string[]; readonly versionTimeoutMs?: number }

async function probeJunoVersion(executable: string, leadingArguments: readonly string[], environment: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<string> {
  const child = spawn(executable, [...leadingArguments, '--version'], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let overflow = false;
  const collect = (target: Buffer[]) => (chunk: Buffer): void => { bytes += chunk.length; if (bytes > 64 * 1024) { overflow = true; child.kill('SIGKILL'); } else target.push(chunk); };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  let timedOut = false; let force: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 1_000); }, timeoutMs);
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); })
    .finally(() => { clearTimeout(timeout); if (force !== undefined) clearTimeout(force); });
  if (overflow) throw new Error('Juno Code version output exceeded 65536 bytes');
  if (timedOut) throw new Error(`Juno Code version probe timed out after ${timeoutMs}ms`);
  const output = Buffer.concat(stdout).toString('utf8').trim();
  if (closed.code !== 0) throw new Error(`Juno Code version probe failed (${closed.code ?? closed.signal ?? 'unknown'}): ${Buffer.concat(stderr).toString('utf8').trim() || 'no stderr'}`);
  const match = /^(?:juno-code\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(output);
  if (match?.[1] === undefined) throw new Error(`Juno Code returned an invalid version: ${output || 'empty output'}`);
  return match[1];
}

export function createJunoRunner(options: SpawnJunoOptions = {}): CandidateRunner {
  return async (input) => {
    const executable = options.executable ?? process.env['JUNO_BENCHMARK_JUNO_EXECUTABLE'] ?? 'yy';
    const leadingArguments = options.leadingArguments ?? [];
    const observedJunoVersion = await probeJunoVersion(executable, leadingArguments, input.environment, input.repository, options.versionTimeoutMs ?? 10_000);
    if (observedJunoVersion !== input.attempt.juno_version) throw new Error(`Juno Code version mismatch: plan requires ${input.attempt.juno_version}, executable reports ${observedJunoVersion}`);
    const args = [...leadingArguments, 'pi', '--execution-envelope', '--model', input.attempt.model, input.prompt];
    const started = new Date(); const monotonic = process.hrtime.bigint();
    const child = spawn(executable, args, { cwd: input.repository, env: input.environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let outputBytes = 0; let overflow = false;
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    let timedOut = false; let force: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 1_000); }, input.timeoutMs);
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); })
      .finally(() => { clearTimeout(timeout); if (force !== undefined) clearTimeout(force); });
    const ended = new Date(); const elapsedMs = Number((process.hrtime.bigint() - monotonic) / 1_000_000n);
    if (overflow) throw new Error('Juno Code output exceeded 8388608 bytes');
    return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: input.attempt.juno_version, observedJunoVersion,
      startedAt: started.toISOString(), endedAt: ended.toISOString(), elapsedMs, exitCode: closed.code, signal: closed.signal,
      timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), patchHash: null };
  };
}

export async function readExecutionPlan(planPath: string): Promise<ExecutionPlan> {
  const value = JSON.parse(await readFile(planPath, 'utf8')) as ExecutionPlan;
  const { plan_id: claimed, ...core } = value;
  if (claimed !== canonicalHash(core)) throw new Error('execution plan hash is invalid');
  validatePlanModelBindings(value);
  return value;
}

export async function writeExecutionPlan(planPath: string, plan: ExecutionPlan): Promise<void> {
  await writeFile(path.resolve(planPath), `${canonicalJson(plan)}\n`, { flag: 'wx', mode: 0o600 });
}

export function patchDigest(bytes: Uint8Array): `sha256:${string}` { return `sha256:${sha256Hex(bytes)}`; }
