import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
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

        Context:
        - with: colon and "quotes"
          deeper continuation line
        line two
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
# Echo the exact final prompt argument on stderr so byte-level argv parity
# with the canonical planner is provable from retained terminal evidence.
for argument in "$@"; do :; done
printf '%s' "$argument" >&2
printf '{"schema_version":"juno_execution_envelope.v1","status":"success","session_id":"%s","provider":"%s","model":"%s","juno_version":"%s","cost":{"completeness":"complete","usd":0.42}}\\n' "$session" "$provider" "$name" "${JUNO_VERSION}"
exit 0
`;

// Recording stub: proves the executed argv (exactly one benchmark-owned
// --execution-envelope in the root position) and the canonical Juno child
// correlation environment, while emitting a valid stub envelope.
const RECORDING_YY = `#!/bin/sh
if [ -n "$YY_STUB_RECORD" ]; then
  {
    printf 'argv:'
    for argument in "$@"; do printf ' <%s>' "$argument"; done
    printf '\\n'
    printf 'correlation: child=%s run=%s step=%s surface=%s\\n' "$YYLO_INVOCATION_CHILD" "$YYLO_WORKFLOW_RUN_ID" "$YYLO_WORKFLOW_STEP_ID" "$YYLO_LAUNCH_SURFACE"
  } >> "$YY_STUB_RECORD"
fi
case "$1" in
  --version) echo "${JUNO_VERSION}"; exit 0 ;;
esac
model=""
prompt=""
prev=""
for argument in "$@"; do
  if [ "$prev" = "--model" ]; then model="$argument"; fi
  prompt="$argument"
  prev="$argument"
done
case "$model" in :*) model="openai-codex/\${model#:}" ;; esac
provider="\${model%%/*}"
name="\${model#*/}"
session="sess-recording-$$"
printf '{"schema_version":"juno_execution_envelope.v1","status":"success","session_id":"%s","provider":"%s","model":"%s","juno_version":"%s","cost":{"completeness":"complete","usd":0.42}}\\n' "$session" "$provider" "$name" "${JUNO_VERSION}"
exit 0
`;

// Live-shaped harness failure: the child terminates with a known nonzero
// status and no envelope, exactly like the consumer's controller-resolver
// refusal observed in live dogfood (exit 99 with a diagnostic on stderr).
const NO_ENVELOPE_YY = `#!/bin/sh
printf 'runs\\n' >> "$YY_STUB_RUNS"
case "$1" in
  --version) echo "${JUNO_VERSION}"; exit 0 ;;
esac
printf 'controller-resolver: retired rollback controller is read-only; run writes from the registered metadata controller\\n' >&2
exit 99
`;

// Completed child with a well-formed envelope for the wrong identity.
const WRONG_IDENTITY_YY = `#!/bin/sh
case "$1" in
  --version) echo "${JUNO_VERSION}"; exit 0 ;;
esac
printf '{"schema_version":"juno_execution_envelope.v1","status":"success","session_id":"sess-wrong","provider":"other-provider","model":"other-model","juno_version":"${JUNO_VERSION}","cost":{"completeness":"complete","usd":0.42}}\\n'
exit 0
`;

interface Harness {
  readonly root: string;
  readonly module: string;
  readonly sha256: string;
  readonly stateRoot: string;
  compiled(model: string): ReturnType<typeof compileWorkflowOverlay>;
  invocation(stepId: string, overrides?: Partial<Record<string, unknown>>): WorkflowRuntimeInvocation;
  invocationFor(compiled: ReturnType<typeof compileWorkflowOverlay>, stepId: string): WorkflowRuntimeInvocation;
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
  const invocationFor = (compiledItem: ReturnType<typeof compileWorkflowOverlay>, stepId: string): WorkflowRuntimeInvocation => {
    const core = { plan_id: 'sha256:' + '1'.repeat(64), model: compiledItem.model, provider: compiledItem.provider, attempt: 1, step_id: stepId,
      workflow_sha256: compiledItem.workflow_sha256, variables_hash: canonicalHash({}), policy_sha256: 'sha256:' + '2'.repeat(64) };
    const dispatchId = canonicalHash(core);
    const invocationCore = { dispatch_id: dispatchId, plan_id: core.plan_id, model: compiledItem.model, provider: compiledItem.provider,
      attempt: 1, step_id: stepId, workflow_sha256: compiledItem.workflow_sha256, workflow_bytes_base64: compiledItem.workflow_bytes_base64,
      variables: {}, timeout_ms: 10_000, deterministic_command: null, juno_version: JUNO_VERSION };
    return Object.freeze({ ...invocationCore, invocation_hash: canonicalHash(invocationCore) }) as WorkflowRuntimeInvocation;
  };
  return {
    root, module: packagedBoundaryModulePath(), sha256: boundarySha256Hex(await packagedBoundaryBytes()), stateRoot, compiled, invocation, invocationFor,
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
  for (const name of ['YYLO_BENCHMARK_BOUNDARY_STATE_ROOT', 'YYLO_BENCHMARK_JUNO_EXECUTABLE', 'OPENAI_CODEX_TOKEN', 'ZAI_API_KEY', 'YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', 'YYLO_BENCHMARK_BOUNDARY_PROJECT_ROOT', 'YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH']) {
    saved[name] = process.env[name];
  }
  setEnv('YYLO_BENCHMARK_BOUNDARY_STATE_ROOT', current.stateRoot);
  setEnv('YYLO_BENCHMARK_JUNO_EXECUTABLE', path.join(current.root, 'fake-yy'));
  setEnv('YYLO_BENCHMARK_BOUNDARY_PROJECT_ROOT', current.root);
  // Pin the auth-store probe to an absent fixture path so credential tests
  // stay deterministic even on hosts that hold a real Pi agent auth store.
  setEnv('YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH', path.join(current.root, 'absent-auth-store.json'));
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

// Drive the reviewed module exactly as the runtime spawns it: module bytes on
// stdin, one JSON request on descriptor 3. Used where the public runtime's own
// pre-validation would otherwise shadow the boundary's independent contract.
async function driveModule(operation: string, invocation: unknown): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const requestFile = path.join(current.root, `boundary-request-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(requestFile, `${JSON.stringify(operation === 'reconcile' ? { invocation } : { invocation })}\n`, { mode: 0o600 });
  const descriptor = openSync(requestFile, 'r');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', operation, '--protocol', 'juno_benchmark_workflow_process_boundary.v1'], {
      input: await readFile(current.module),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe', descriptor],
      timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout?.toString() ?? '', stderr: result.stderr?.toString() ?? '' };
  } finally {
    closeSync(descriptor);
  }
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

  it('authenticates openai-codex from the Pi agent auth store without an environment credential', async () => {
    setEnv('OPENAI_CODEX_TOKEN', undefined);
    await writeFile(path.join(current.root, 'agent-auth.json'), `${JSON.stringify({
      'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000, accountId: 'fixture-account' },
    })}\n`, { mode: 0o600 });
    setEnv('YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH', path.join(current.root, 'agent-auth.json'));
    const probe = await createReviewedBoundaryReadinessProbe({ module: current.module, sha256: current.sha256 });
    await expect(probe.preflightIdentity({ provider: 'openai-codex', model: 'openai-codex/gpt-5.6-terra', junoVersion: JUNO_VERSION })).resolves.toBeUndefined();
  });

  it('fails closed when the Pi agent auth store credential is expired, incomplete, or malformed', async () => {
    setEnv('OPENAI_CODEX_TOKEN', undefined);
    const probe = await createReviewedBoundaryReadinessProbe({ module: current.module, sha256: current.sha256 });
    const preflight = () => probe.preflightIdentity({ provider: 'openai-codex', model: 'openai-codex/gpt-5.6-terra', junoVersion: JUNO_VERSION });
    const store = async (document: unknown) => {
      await writeFile(path.join(current.root, 'agent-auth.json'), `${typeof document === 'string' ? document : JSON.stringify(document)}\n`, { mode: 0o600 });
      setEnv('YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH', path.join(current.root, 'agent-auth.json'));
    };
    await store({ 'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() - 1_000 } });
    await expect(preflight()).rejects.toThrow(/expired.*import-codex/us);
    await store({ 'openai-codex': { type: 'oauth', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 } });
    await expect(preflight()).rejects.toThrow(/complete OAuth entry/u);
    await store({ 'zai': { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 } });
    await expect(preflight()).rejects.toThrow(/has no openai-codex credential/u);
    await store('{ not json');
    await expect(preflight()).rejects.toThrow(/malformed/u);
    setEnv('YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH', path.join(current.root, 'absent-auth-store.json'));
    await expect(preflight()).rejects.toThrow(/OPENAI_CODEX_TOKEN/u);
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

  it('requests exactly one benchmark-owned envelope flag in the root argv position with child correlation', async () => {
    const stub = path.join(current.root, 'recording-yy');
    await writeFile(stub, RECORDING_YY, { mode: 0o755 });
    const record = path.join(current.root, 'recording.log');
    setEnv('YYLO_BENCHMARK_JUNO_EXECUTABLE', stub);
    setEnv('YY_STUB_RECORD', record);
    const boundary = await liveBoundary();
    const input = current.invocation('analyze');
    const result = await boundary.dispatcher.dispatch(input);
    expect(result.status).toBe('success');
    const lines = (await readFile(record, 'utf8')).split('\n').filter(Boolean);
    const argvLine = lines.find((line) => line.startsWith('argv:'));
    const correlationLine = lines.find((line) => line.startsWith('correlation:'));
    expect(argvLine).toBeDefined();
    expect(correlationLine).toBeDefined();
    const argv = argvLine!.slice('argv:'.length).trim().split(' <').map((item) => item.replace(/>$/u, '').replace(/^</u, ''));
    // The validated product-owned argv is [yy, pi, --model, <selector>, <prompt>];
    // the executed argv carries exactly one benchmark-owned transport flag in
    // the root/global position Juno parses, never after the pi alias.
    expect(argv[0]).toBe('--execution-envelope');
    expect(argv[1]).toBe('pi');
    expect(argv[2]).toBe('--model');
    expect(argv.filter((item) => item === '--execution-envelope')).toHaveLength(1);
    expect(argvLine).not.toMatch(/pi <\/?--execution-envelope/u);
    expect(correlationLine).toBe(`correlation: child=1 run=${input.plan_id} step=analyze surface=yylo-benchmark`);
  });

  it('retains a redacted harness-failure terminal when a completed child yields no envelope', async () => {
    const stub = path.join(current.root, 'no-envelope-yy');
    await writeFile(stub, NO_ENVELOPE_YY, { mode: 0o755 });
    const runs = path.join(current.root, 'stub-runs.log');
    setEnv('YYLO_BENCHMARK_JUNO_EXECUTABLE', stub);
    setEnv('YY_STUB_RUNS', runs);
    const boundary = await liveBoundary();
    const input = current.invocation('analyze');
    const result = await boundary.dispatcher.dispatch(input);
    expect(result).toMatchObject({ dispatch_id: input.dispatch_id, status: 'failure', effect: 'completed',
      observed_provider: 'openai-codex', observed_model: 'openai-codex/gpt-5.6-terra', observed_juno_version: JUNO_VERSION });
    expect(result.evidence.harness_validity).toEqual({ status: 'invalid',
      reason: expect.stringMatching(/produced no juno_execution_envelope\.v1 terminal identity \(exit 99\)/u) });
    expect(result.evidence.cost).toEqual({ completeness: 'unavailable', usd: null });
    expect(result.evidence.candidate_outcome).toEqual({ status: 'failure' });
    expect(result.evidence.outer_session_id).toMatch(/^boundary-/u);
    expect(result.evidence.nested_session_ids).toEqual([expect.stringMatching(/^unavailable-/u)]);
    expect(result.evidence.transcript).toContain('retired rollback controller is read-only');
    const { terminal } = current.journal(input.dispatch_id);
    expect(JSON.parse(await readFile(terminal, 'utf8'))).toMatchObject({ dispatch_id: input.dispatch_id });
    const reconciliation = await boundary.dispatcher.reconcile(input);
    expect(reconciliation).toMatchObject({ state: 'terminal' });
    // Recovery never redispatches a completed harness failure.
    const redispatch = await boundary.dispatcher.dispatch(input);
    expect(redispatch.evidence.harness_validity.status).toBe('invalid');
    expect(await readFile(runs, 'utf8')).toBe('runs\n');
  });

  it('retains a harness-failure terminal on identity-mismatched envelope output', async () => {
    const stub = path.join(current.root, 'wrong-identity-yy');
    await writeFile(stub, WRONG_IDENTITY_YY, { mode: 0o755 });
    setEnv('YYLO_BENCHMARK_JUNO_EXECUTABLE', stub);
    const boundary = await liveBoundary();
    const input = current.invocation('analyze');
    const result = await boundary.dispatcher.dispatch(input);
    expect(result.status).toBe('failure');
    expect(result.evidence.harness_validity).toEqual({ status: 'invalid',
      reason: expect.stringMatching(/terminal identity does not match the exact requested provider\/model\/version \(exit 0\)/u) });
    expect(result.observed_provider).toBe('openai-codex');
  });

  it('substitutes bound workflow variables and parses quoted and multiline prompts exactly', async () => {
    setEnv('YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', '1');
    const boundary = await liveBoundary();
    const analyze = await boundary.dispatcher.dispatch(current.invocation('analyze'));
    expect(analyze.evidence.transcript).toContain('Analyze the 2026-08-19 snapshot');
    const summarize = await boundary.dispatcher.dispatch(current.invocation('summarize'));
    expect(summarize.evidence.transcript).toContain('Summarize line one\n\nContext:\n- with: colon and "quotes"\n  deeper continuation line\nline two\n');
    const compute = await boundary.dispatcher.dispatch(current.invocation('compute'));
    expect(compute.evidence.transcript).toContain('--date 2026-08-19');
  });

  it('round-trips every canonical planner block-scalar form through the exact dispatched argv', async () => {
    // The Convert Daily Ops planner emits multiline prompt scalars with blank
    // lines, deeper content indentation, trailing-newline variants, explicit
    // indentation indicators, and tabs inside content; the boundary reader
    // must accept each byte stream the same compiler produces, exactly.
    const prompts = [
      'clip line\nsecond line\n',
      'strip line\nsecond line',
      'keep line\nsecond line\n\n',
      'blank\n\ninterior\n\nlines\n',
      'deeper\n  indented continuation\nback\n',
      'spaces on blank\n   \nline\n',
      '  leading space first\nsecond\n',
      'tab\n\tcontent\nline\n',
      '%ralph-loop Do the thing.\n\nContext:\n- item: one\n  deeper: two\n\nFinish with:\n  AGENT_RESPONSE_ONE_LINE: <one sentence>\n',
    ];
    const boundary = await liveBoundary();
    for (const [index, prompt] of prompts.entries()) {
      const source = `schema_version: 2\nworkflow_id: boundary-fixture-${index}\nvariables:\n  run_date: '1970-01-01'\nsteps:\n  - id: prompt_step\n    command: [yy, pi, ${JSON.stringify(prompt)}]\n`;
      const parsed = parseWorkflowBytes(Buffer.from(source, 'utf8'));
      const compiled = compileWorkflowOverlay(parsed, ['prompt_step'], {
        selector: ':gpt-5.6-terra', exact: 'openai-codex/gpt-5.6-terra', provider: 'openai-codex', modelName: 'gpt-5.6-terra',
      }, [], POLICY);
      const text = Buffer.from(compiled.workflow_bytes_base64, 'base64').toString('utf8');
      const canonical = (parseYaml(text) as { steps: Array<{ command: string[] }> }).steps[0]!.command;
      expect(canonical[canonical.length - 1]).toBe(prompt);
      const invocation = current.invocationFor(compiled, 'prompt_step');
      const result = await boundary.dispatcher.dispatch(invocation);
      expect(result.status).toBe('success');
      expect(result.evidence.transcript).toContain(`[stderr]\n${prompt}`);
      const { intent } = current.journal(invocation.dispatch_id);
      expect(JSON.parse(await readFile(intent, 'utf8'))).toMatchObject({ dispatch_id: invocation.dispatch_id, transport: 'live' });
    }
  });

  it('rejects unparsable compiled workflow bytes inside the boundary before any durable dispatch intent', async () => {
    // The public runtime re-parses with its own YAML stack, so this proof
    // drives the reviewed module directly: hash-consistent garbage bytes must
    // be rejected by the boundary's own reader with no intent journal, leaving
    // reconcile to report proven_not_dispatched.
    const input = current.invocation('analyze');
    const bytes = Buffer.from('steps: [ {id: broken\n', 'utf8');
    const { invocation_hash: _ignored, ...core } = input;
    const forged = {
      ...core,
      workflow_bytes_base64: bytes.toString('base64'),
      workflow_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
    };
    const invocationHash = canonicalHash(forged);
    const request = { ...forged, invocation_hash: invocationHash };
    const rejection = await driveModule('dispatch', request);
    expect(rejection.status).toBe(1);
    expect(JSON.parse(rejection.stdout)).toMatchObject({ schema_version: 'juno_benchmark_boundary_error.v1', message: expect.stringMatching(/cannot be parsed/u) });
    await expect(readFile(current.journal(request.dispatch_id).intent, 'utf8')).rejects.toThrow(/ENOENT/u);
    const reconcile = await driveModule('reconcile', request);
    expect(reconcile.status).toBe(0);
    expect(JSON.parse(reconcile.stdout)).toEqual({ state: 'proven_not_dispatched' });
  });

  it('rejects deterministic policy drift inside the boundary before any durable dispatch intent', async () => {
    const drifted = current.invocation('compute', { deterministic_command: { ...DETERMINISTIC, script: 'scripts/other.py' } });
    const rejection = await driveModule('dispatch', drifted);
    expect(rejection.status).toBe(1);
    expect(JSON.parse(rejection.stdout)).toMatchObject({ schema_version: 'juno_benchmark_boundary_error.v1', message: expect.stringMatching(/drifted from the exact policy binding/u) });
    await expect(readFile(current.journal(drifted.dispatch_id).intent, 'utf8')).rejects.toThrow(/ENOENT/u);
    const reconcile = await driveModule('reconcile', drifted);
    expect(reconcile.status).toBe(0);
    expect(JSON.parse(reconcile.stdout)).toEqual({ state: 'proven_not_dispatched' });
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

  it('rejects product-owned workflow argv carrying the benchmark transport flag before durable intent', async () => {
    // Workflow YAML stays product-owned: a compiled command that already
    // carries the benchmark envelope transport flag must be refused before
    // any durable dispatch intent, leaving the step provably not dispatched.
    const bytes = Buffer.from(`schema_version: 2
workflow_id: boundary-fixture
variables:
  run_date: 1970-01-01
steps:
  - id: analyze
    command:
      - yy
      - pi
      - --execution-envelope
      - --model
      - :gpt-5.6-terra
      - Analyze the 1970-01-01 snapshot
`, 'utf8');
    const input = current.invocation('analyze');
    const { invocation_hash: _ignored, ...core } = input;
    const forged = {
      ...core,
      workflow_bytes_base64: bytes.toString('base64'),
      workflow_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
    };
    const request = { ...forged, invocation_hash: canonicalHash(forged) };
    const rejection = await driveModule('dispatch', request);
    expect(rejection.status).toBe(1);
    expect(JSON.parse(rejection.stdout)).toMatchObject({ schema_version: 'juno_benchmark_boundary_error.v1',
      message: expect.stringMatching(/must not carry the benchmark envelope transport flag/u) });
    await expect(readFile(current.journal(request.dispatch_id).intent, 'utf8')).rejects.toThrow(/ENOENT/u);
    const reconcile = await driveModule('reconcile', request);
    expect(JSON.parse(reconcile.stdout)).toEqual({ state: 'proven_not_dispatched' });
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
