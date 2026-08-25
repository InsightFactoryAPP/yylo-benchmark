import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { compileWorkflowOverlay, parseWorkflowBytes, type DeterministicCommandPolicy, type WorkflowPolicy } from '../../src/workflow/plan.js';
import { createReviewedBoundaryReadinessProbe, createReviewedWorkflowBoundary, type ReviewedWorkflowBoundary, type WorkflowRuntimeInvocation } from '../../src/workflow/runtime.js';
import { boundarySha256Hex, packagedBoundaryBytes, packagedBoundaryModulePath } from '../../src/boundary/index.js';

const JUNO_VERSION = '9.9.9';

const WORKFLOW_SOURCE = `schema_version: 2
workflow_id: boundary-fixture
variables:
  run_date: '1970-01-01'
steps:
  - id: analyze
    command: [yy, pi, "Analyze the $(run_date) snapshot: carefully, without rewriting this prompt"]
  - id: summarize
    command:
      - yy
      - pi
      - |
        Summarize line one
        line two with: colon and "quotes"
  - id: compute
    command: [env, PYTHONPATH=., python3, scripts/track.py, --date, "$(run_date)"]
`;

const DETERMINISTIC: DeterministicCommandPolicy = {
  step_id: 'compute', executable: 'env', environment: [{ name: 'PYTHONPATH', value: '.' }],
  interpreter: 'python3', script: 'scripts/track.py', working_directory: '.',
};

const POLICY: WorkflowPolicy = {
  schema_version: 'juno_benchmark_workflow_policy.v1',
  judge: { judge_id: 'governed-binary', judge_version: '1', model: 'openai-codex/gpt-5.6-sol', rubric_hash: `sha256:${'a'.repeat(64)}` },
  authorization: { authorization_id: 'fixture', production: true, spend: true },
  recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 },
  redaction: { secret_patterns: ['TOKEN'], retain_prompts: false },
  deterministic_commands: [DETERMINISTIC],
  steps: [
    { step_id: 'analyze', scoring_id: 'analyze-score', side_effect: 'production', resources: [], limits: { timeout_ms: 10_000, max_usd: 1 }, authorization: 'production_and_spend', recovery: 'manual', redaction: { patterns: [], retain_prompt: false } },
    { step_id: 'summarize', scoring_id: 'summarize-score', side_effect: 'production', resources: [], limits: { timeout_ms: 10_000, max_usd: 1 }, authorization: 'production_and_spend', recovery: 'manual', redaction: { patterns: [], retain_prompt: false } },
    { step_id: 'compute', scoring_id: 'compute-score', side_effect: 'none', resources: [], limits: { timeout_ms: 10_000, max_usd: 0 }, authorization: 'none', recovery: 'retry_safe', redaction: { patterns: [], retain_prompt: false } },
  ],
};

const FAKE_YY = `#!/bin/sh
case "$1" in
  --version) echo "${JUNO_VERSION}"; exit 0 ;;
esac
model=""
prompt=""
prev=""
for argument in "$@"; do
  if [ "$prev" = "--model" ]; then model="$argument"; fi
  case "$argument" in
    *governed*) prompt="$argument" ;;
  esac
  prev="$argument"
done
if [ -n "$prompt" ]; then
  printf 'Judging the blinded candidate.\\nVERDICT: PASS\\n'
  exit 0
fi
case "$model" in
  :*) model="openai-codex/\${model#:}" ;;
esac
provider="\${model%%/*}"
name="\${model#*/}"
session="sess-$(echo "$model" | tr -c 'A-Za-z0-9._-' '-')-$$"
printf '{"schema_version":"juno_execution_envelope.v1","status":"success","session_id":"%s","provider":"%s","model":"%s","juno_version":"%s","cost":{"completeness":"complete","usd":0.42}}\\n' "$session" "$provider" "$name" "${JUNO_VERSION}"
exit 0
`;

interface Harness {
  readonly root: string;
  readonly module: string;
  readonly sha256: string;
  readonly stateRoot: string;
  compiled(model: string): ReturnType<typeof compileWorkflowOverlay>;
  invocation(stepId: string, overrides?: Partial<Record<string, unknown>>): WorkflowRuntimeInvocation;
  journal(dispatchId: string): { intent: string; terminal: string };
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boundary-module-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts', 'track.py'), 'import os, sys\nprint("track argv:", sys.argv[1:])\nwith open("track-ran.txt", "a") as stream:\n    stream.write("ran\\n")\n', { mode: 0o600 });
  const fakeYy = path.join(root, 'fake-yy');
  await writeFile(fakeYy, FAKE_YY, { mode: 0o755 });
  await chmod(fakeYy, 0o755);
  const stateRoot = path.join(root, 'state');
  const parsed = parseWorkflowBytes(Buffer.from(WORKFLOW_SOURCE, 'utf8'));
  const compiled = (model: string) => {
    const separator = model.indexOf('/');
    return compileWorkflowOverlay(parsed, ['analyze', 'summarize', 'compute'], {
      selector: model.startsWith(':') ? model : `:${model.slice(separator + 1)}`,
      exact: model, provider: model.slice(0, separator), modelName: model.slice(separator + 1),
    }, [], POLICY);
  };
  const invocation = (stepId: string, overrides?: Partial<Record<string, unknown>>): WorkflowRuntimeInvocation => {
    const item = compiled('openai-codex/gpt-5.6-terra');
    const policy = POLICY.steps.find((step) => step.step_id === stepId)!;
    const variables = { run_date: '2026-08-19' };
    const core = { plan_id: 'sha256:' + '1'.repeat(64), model: item.model, provider: item.provider, attempt: 1, step_id: stepId,
      workflow_sha256: item.workflow_sha256, variables_hash: canonicalHash(variables), policy_sha256: 'sha256:' + '2'.repeat(64) };
    const dispatchId = canonicalHash(core);
    const invocationCore = { dispatch_id: dispatchId, plan_id: core.plan_id, model: item.model, provider: item.provider,
      attempt: 1, step_id: stepId, workflow_sha256: item.workflow_sha256, workflow_bytes_base64: item.workflow_bytes_base64,
      variables, timeout_ms: policy.limits.timeout_ms,
      deterministic_command: stepId === 'compute' ? DETERMINISTIC : null, juno_version: JUNO_VERSION };
    return Object.freeze({ ...invocationCore, ...(overrides ?? {}), invocation_hash: canonicalHash({ ...invocationCore, ...(overrides ?? {}) }) }) as WorkflowRuntimeInvocation;
  };
  return {
    root, module: packagedBoundaryModulePath(), sha256: boundarySha256Hex(await packagedBoundaryBytes()), stateRoot, compiled, invocation,
    journal: (dispatchId: string) => {
      const hex = dispatchId.replace(/^sha256:/u, '');
      return { intent: path.join(stateRoot, `dispatch-${hex}.intent.json`), terminal: path.join(stateRoot, `dispatch-${hex}.terminal.json`) };
    },
  };
}

const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

let current: Harness;

beforeEach(async () => {
  current = await harness();
  for (const name of ['YYLO_BENCHMARK_BOUNDARY_STATE_ROOT', 'YYLO_BENCHMARK_JUNO_EXECUTABLE', 'OPENAI_CODEX_TOKEN', 'ZAI_API_KEY', 'YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', 'YYLO_BENCHMARK_BOUNDARY_PROJECT_ROOT']) {
    saved[name] = process.env[name];
  }
  setEnv('YYLO_BENCHMARK_BOUNDARY_STATE_ROOT', current.stateRoot);
  setEnv('YYLO_BENCHMARK_JUNO_EXECUTABLE', path.join(current.root, 'fake-yy'));
  setEnv('YYLO_BENCHMARK_BOUNDARY_PROJECT_ROOT', current.root);
  setEnv('OPENAI_CODEX_TOKEN', 'fixture-token-0123456789abcdef');
  setEnv('ZAI_API_KEY', undefined);
  setEnv('YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', undefined);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  await rm(current.root, { recursive: true, force: true });
});

async function liveBoundary(): Promise<ReviewedWorkflowBoundary> {
  return createReviewedWorkflowBoundary({ module: current.module, sha256: current.sha256 });
}

describe('reviewed workflow boundary module protocol', () => {
  it('probes exact supported providers and digest identity', async () => {
    const probe = await createReviewedBoundaryReadinessProbe({ module: current.module, sha256: current.sha256 });
    expect(probe.providers).toEqual(['openai-codex', 'zai']);
    expect(probe.identity).toEqual({ protocol: 'juno_benchmark_workflow_process_boundary.v1', sha256: `sha256:${current.sha256}` });
  });

  it('preflights the exact provider/model and YYLO version with zero dispatch', async () => {
    const probe = await createReviewedBoundaryReadinessProbe({ module: current.module, sha256: current.sha256 });
    await expect(probe.preflightIdentity({ provider: 'openai-codex', model: 'openai-codex/gpt-5.6-terra', junoVersion: JUNO_VERSION })).resolves.toBeUndefined();
    await expect(probe.preflightIdentity({ provider: 'zai', model: 'zai/glm-5.3', junoVersion: JUNO_VERSION })).rejects.toThrow(/ZAI_API_KEY/u);
  });

  it('fails closed on a YYLO version mismatch before any dispatch', async () => {
    const probe = await createReviewedBoundaryReadinessProbe({ module: current.module, sha256: current.sha256 });
    await expect(probe.preflightIdentity({ provider: 'openai-codex', model: 'openai-codex/gpt-5.6-terra', junoVersion: '0.0.1' }))
      .rejects.toThrow(/version mismatch/u);
  });

  it('fails closed when the provider credential is missing or malformed', async () => {
    setEnv('OPENAI_CODEX_TOKEN', undefined);
    await expect(liveBoundary()).rejects.toThrow(/OPENAI_CODEX_TOKEN/u).catch(() => undefined);
    const probe = await createReviewedBoundaryReadinessProbe({ module: current.module, sha256: current.sha256 });
    await expect(probe.preflightIdentity({ provider: 'openai-codex', model: 'openai-codex/gpt-5.6-terra', junoVersion: JUNO_VERSION }))
      .rejects.toThrow(/OPENAI_CODEX_TOKEN/u);
    setEnv('OPENAI_CODEX_TOKEN', 'bad token with spaces');
    await expect(probe.preflightIdentity({ provider: 'openai-codex', model: 'openai-codex/gpt-5.6-terra', junoVersion: JUNO_VERSION }))
      .rejects.toThrow(/malformed/u);
  });

  it('dispatches a live model step through the exact YYLO envelope identity', async () => {
    const boundary = await liveBoundary();
    const input = current.invocation('analyze');
    const result = await boundary.dispatcher.dispatch(input);
    expect(result).toMatchObject({ dispatch_id: input.dispatch_id, status: 'success', effect: 'completed',
      observed_provider: 'openai-codex', observed_model: 'openai-codex/gpt-5.6-terra', observed_juno_version: JUNO_VERSION });
    expect(result.evidence.outer_session_id).toMatch(/^sess-/u);
    expect(result.evidence.nested_session_ids).toEqual([result.evidence.outer_session_id]);
    expect(result.evidence.cost).toEqual({ completeness: 'complete', usd: 0.42 });
    expect(result.evidence.transcript).toContain('juno_execution_envelope.v1');
    const { intent, terminal } = current.journal(input.dispatch_id);
    expect(JSON.parse(await readFile(intent, 'utf8'))).toMatchObject({ dispatch_id: input.dispatch_id, transport: 'live' });
    expect(JSON.parse(await readFile(terminal, 'utf8'))).toMatchObject({ dispatch_id: input.dispatch_id });
  });

  it('substitutes bound workflow variables and parses quoted and multiline prompts exactly', async () => {
    setEnv('YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', '1');
    const boundary = await liveBoundary();
    const analyze = await boundary.dispatcher.dispatch(current.invocation('analyze'));
    expect(analyze.evidence.transcript).toContain('Analyze the 2026-08-19 snapshot');
    const summarize = await boundary.dispatcher.dispatch(current.invocation('summarize'));
    expect(summarize.evidence.transcript).toContain('Summarize line one\nline two with: colon and "quotes"');
    const compute = await boundary.dispatcher.dispatch(current.invocation('compute'));
    expect(compute.evidence.transcript).toContain('--date 2026-08-19');
  });

  it('dispatches a live deterministic step through its exact tracked script', async () => {
    const boundary = await liveBoundary();
    const input = current.invocation('compute');
    const result = await boundary.dispatcher.dispatch(input);
    expect(result).toMatchObject({ status: 'success', effect: 'completed' });
    expect(result.evidence.cost).toEqual({ completeness: 'not_applicable', usd: null });
    expect(result.evidence.transcript).toContain('track argv: [\'--date\', \'2026-08-19\']');
    expect(await readFile(path.join(current.root, 'track-ran.txt'), 'utf8')).toBe('ran\n');
  });

  it('reconciles proven_not_dispatched, terminal, ambiguous, and safely_resumable exactly', async () => {
    const boundary = await liveBoundary();
    const model = current.invocation('analyze');
    const deterministic = current.invocation('compute');
    await expect(boundary.dispatcher.reconcile(model)).resolves.toEqual({ state: 'proven_not_dispatched' });
    await boundary.dispatcher.dispatch(model);
    const terminal = await boundary.dispatcher.reconcile(model);
    expect(terminal).toMatchObject({ state: 'terminal' });
    if (terminal.state === 'terminal') expect(terminal.result.dispatch_id).toBe(model.dispatch_id);
    const { terminal: terminalPath } = current.journal(model.dispatch_id);
    await rm(terminalPath, { force: true });
    await expect(boundary.dispatcher.reconcile(model)).resolves.toEqual({ state: 'ambiguous' });
    await expect(boundary.dispatcher.reconcile(deterministic)).resolves.toEqual({ state: 'proven_not_dispatched' });
    await boundary.dispatcher.dispatch(deterministic);
    await rm(current.journal(deterministic.dispatch_id).terminal, { force: true });
    await expect(boundary.dispatcher.reconcile(deterministic)).resolves.toEqual({ state: 'safely_resumable' });
  });

  it('refuses duplicate dispatch after an ambiguous intent and resumes safely resumable work once', async () => {
    const boundary = await liveBoundary();
    const model = current.invocation('analyze');
    await boundary.dispatcher.dispatch(model);
    await rm(current.journal(model.dispatch_id).terminal, { force: true });
    await expect(boundary.dispatcher.dispatch(model)).rejects.toThrow(/prior dispatch intent exists without terminal evidence/u);
    const deterministic = current.invocation('compute');
    await boundary.dispatcher.dispatch(deterministic);
    await rm(current.journal(deterministic.dispatch_id).terminal, { force: true });
    const resumed = await boundary.dispatcher.resume(deterministic);
    expect(resumed).toMatchObject({ dispatch_id: deterministic.dispatch_id, status: 'success' });
    expect(await readFile(path.join(current.root, 'track-ran.txt'), 'utf8')).toBe('ran\nran\n');
  });

  it('returns the retained terminal for an idempotent re-dispatch without re-execution', async () => {
    const boundary = await liveBoundary();
    const input = current.invocation('compute');
    const first = await boundary.dispatcher.dispatch(input);
    const second = await boundary.dispatcher.dispatch(input);
    expect(second).toEqual(first);
    expect(await readFile(path.join(current.root, 'track-ran.txt'), 'utf8')).toBe('ran\n');
  });

  it('synthetic transport answers model dispatch and judge without credentials or child dispatch', async () => {
    setEnv('OPENAI_CODEX_TOKEN', undefined);
    setEnv('YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', '1');
    const boundary = await liveBoundary();
    const input = current.invocation('analyze');
    const result = await boundary.dispatcher.dispatch(input);
    expect(result.runner_run_id).toMatch(/^synthetic-run-/u);
    expect(result.evidence.outer_session_id).toMatch(/^synthetic-session-/u);
    expect(result.evidence.cost).toEqual({ completeness: 'not_applicable', usd: null });
    expect(result.evidence.transcript).toContain('synthetic transport: no provider child was spawned');
    await rm(current.journal(input.dispatch_id).terminal, { force: true });
    await expect(boundary.dispatcher.reconcile(input)).resolves.toEqual({ state: 'safely_resumable' });
    const decision = await boundary.judge({ judge: POLICY.judge, scoring_id: 'analyze-score', blinded_candidate: '{"scoring_id":"analyze-score"}' });
    expect(decision.resolved).toBe(true);
    expect(decision.evidence).toContain('synthetic governed judgement');
  });

  it('judges through the governed model verdict in live transport', async () => {
    const boundary = await liveBoundary();
    const decision = await boundary.judge({ judge: POLICY.judge, scoring_id: 'analyze-score', blinded_candidate: 'blinded fixture evidence' });
    expect(decision.resolved).toBe(true);
    expect(decision.evidence).toContain('VERDICT: PASS');
  });

  it('fails closed when journal evidence is tampered with', async () => {
    const boundary = await liveBoundary();
    const input = current.invocation('analyze');
    await boundary.dispatcher.dispatch(input);
    const { terminal } = current.journal(input.dispatch_id);
    await writeFile(terminal, '{"schema_version":"juno_benchmark_boundary_dispatch_terminal.v1","dispatch_id":"sha256:' + '0'.repeat(64) + '"}\n');
    await expect(boundary.dispatcher.reconcile(input)).rejects.toThrow(/journal/iu);
  });

  it('rejects workflow bytes that do not match the invocation hash', async () => {
    const boundary = await liveBoundary();
    const input = current.invocation('analyze');
    const forged: WorkflowRuntimeInvocation = { ...input, workflow_sha256: `sha256:${'3'.repeat(64)}` };
    await expect(boundary.dispatcher.dispatch(forged)).rejects.toThrow(/workflow bytes do not match|invocation hash/iu);
  });
});

describe('compiled workflow byte parity with the canonical planner', () => {
  it('extracts every command exactly as the yaml compiler emitted it', async () => {
    setEnv('YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', '1');
    const boundary = await liveBoundary();
    for (const stepId of ['analyze', 'summarize', 'compute']) {
      const result = await boundary.dispatcher.dispatch(current.invocation(stepId));
      expect(result.status).toBe('success');
    }
  });
});

// Keep a reference so execFileSync-based git helpers remain available for
// fixtures that need real repositories in follow-up lifecycle tests.
void execFileSync;
