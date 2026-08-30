import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { boundarySha256Hex, packagedBoundaryBytes, BOUNDARY_SETUP_FILENAME } from '../../src/boundary/index.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { readWorkflowEvidenceReceipts } from '../../src/workflow/evidence.js';

const JUNO_VERSION = '9.9.9';

const FAKE_YY = `#!/bin/sh
case "$1" in
  --version) echo "${JUNO_VERSION}"; exit 0 ;;
esac
printf 'unexpected invocation: %s\\n' "$*"
exit 3
`;

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boundary-cli-'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts', 'track.py'), 'import sys\nprint("track argv:", sys.argv[1:])\n');
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify({
    schema_version: 'juno_benchmark_config.v1', repository_id: 'boundary-cli-fixture',
    model_aliases: { ':mini': 'openai-codex/gpt-5.6-terra' },
  }));
  await writeFile(path.join(root, 'workflow.yaml'), `schema_version: 2\nworkflow_id: boundary-cli\nvariables:\n  run_date: '1970-01-01'\nsteps:\n  - id: analyze\n    command: [yy, pi, "Analyze the $(run_date) snapshot"]\n  - id: compute\n    command: [env, PYTHONPATH=., python3, scripts/track.py, "--date", "$(run_date)"]\n`);
  await writeFile(path.join(root, 'policy.yaml'), JSON.stringify({
    schema_version: 'juno_benchmark_workflow_policy.v1',
    judge: { judge_id: 'governed-binary', judge_version: '1', model: 'openai-codex/gpt-5.6-sol', rubric_hash: 'sha256:9dbb9b78955fdf1dbacbc5a2004dce18a1d97e8c5f2f239e6bfe4a3e5dfc1b4d', rubric: 'binary rubric' },
    authorization: { authorization_id: 'fixture', production: true, spend: true },
    recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 },
    redaction: { secret_patterns: ['TOKEN'], retain_prompts: false },
    deterministic_commands: [{ step_id: 'compute', executable: 'env', environment: [{ name: 'PYTHONPATH', value: '.' }], interpreter: 'python3', script: 'scripts/track.py', working_directory: '.' }],
    steps: [
      { step_id: 'analyze', scoring_id: 'analyze-score', side_effect: 'production', resources: [], limits: { timeout_ms: 10_000, max_usd: 1 }, authorization: 'production_and_spend', recovery: 'manual', redaction: { patterns: [], retain_prompt: false } },
      { step_id: 'compute', scoring_id: 'compute-score', side_effect: 'none', resources: [], limits: { timeout_ms: 10_000, max_usd: 0 }, authorization: 'none', recovery: 'retry_safe', redaction: { patterns: [], retain_prompt: false } },
    ],
  }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'workflow.yaml', 'policy.yaml', 'scripts/track.py'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

async function capture(root: string, args: string[]): Promise<Record<string, unknown>> {
  const output: string[] = [];
  await runCli(args, { cwd: root, stdout: (text) => { output.push(text); } });
  return JSON.parse(output.join('')) as Record<string, unknown>;
}

const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

let root: string;
let fakeYy: string;

beforeEach(async () => {
  root = await project();
  fakeYy = path.join(root, 'fake-yy');
  await writeFile(fakeYy, FAKE_YY, { mode: 0o755 });
  await chmod(fakeYy, 0o755);
  for (const name of ['YYLO_BENCHMARK_JUNO_EXECUTABLE', 'YYLO_BENCHMARK_JUNO_VERSION', 'YYLO_BENCHMARK_REGISTRY', 'YYLO_BENCHMARK_WORKFLOW_BOUNDARY', 'YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256', 'YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', 'YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH', 'OPENAI_CODEX_TOKEN', 'ZAI_API_KEY']) {
    saved[name] = process.env[name];
  }
  setEnv('YYLO_BENCHMARK_JUNO_EXECUTABLE', fakeYy);
  setEnv('YYLO_BENCHMARK_JUNO_VERSION', JUNO_VERSION);
  setEnv('YYLO_BENCHMARK_REGISTRY', undefined);
  setEnv('YYLO_BENCHMARK_BOUNDARY_SYNTHETIC', undefined);
  // Pin the auth-store probe to an absent fixture path so "live credentials
  // are absent" stays deterministic on hosts holding a real Pi auth store.
  setEnv('YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH', path.join(root, 'absent-auth-store.json'));
  setEnv('OPENAI_CODEX_TOKEN', undefined);
  setEnv('ZAI_API_KEY', undefined);
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  await rm(root, { recursive: true, force: true });
});

describe('boundary setup and readiness', () => {
  it('installs the reviewed hash-pinned boundary without credentials', async () => {
    const receipt = await capture(root, ['setup']);
    const digest = boundarySha256Hex(await packagedBoundaryBytes());
    const canonicalRoot = await realpath(root);
    expect(receipt).toMatchObject({
      schema_version: 'juno_benchmark_boundary_setup_receipt.v1',
      boundary: { path: path.join(canonicalRoot, '.juno_task', 'boundary', 'yylo-workflow-boundary.mjs'), sha256: `sha256:${digest}`, protocol: 'juno_benchmark_workflow_process_boundary.v1' },
      registry: { backend: 'local', root: path.join(root, '.juno_task', 'artifacts', 'yylo-benchmark') },
      providers: ['openai-codex', 'zai'],
      synthetic: false,
      environment: { YYLO_BENCHMARK_WORKFLOW_BOUNDARY: path.join(canonicalRoot, '.juno_task', 'boundary', 'yylo-workflow-boundary.mjs'), YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: digest },
    });
    const setupRaw = await readFile(path.join(root, BOUNDARY_SETUP_FILENAME), 'utf8');
    expect(setupRaw).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY/u);
    const installed = await readFile(path.join(root, '.juno_task', 'boundary', 'yylo-workflow-boundary.mjs'));
    expect(boundarySha256Hex(installed)).toBe(digest);
  });

  it('is idempotent for identical reviewed bytes and refuses drifted bytes', async () => {
    await capture(root, ['setup']);
    await expect(capture(root, ['setup'])).resolves.toBeTruthy();
    const installed = path.join(root, '.juno_task', 'boundary', 'yylo-workflow-boundary.mjs');
    await chmod(installed, 0o644);
    await writeFile(installed, `${await readFile(installed)}\n// tampered\n`);
    await expect(runCli(['setup'], { cwd: root })).rejects.toThrow(/different bytes/u);
  });

  it('rejects unsupported providers', async () => {
    await expect(runCli(['setup', '--providers', 'openai-codex,acme'], { cwd: root })).rejects.toThrow(/unsupported boundary provider acme/u);
  });

  it('emits a retained zero-dispatch readiness receipt with exact identities', async () => {
    await capture(root, ['setup', '--synthetic']);
    const receipt = await capture(root, ['readiness', '--models', ':mini,zai/glm-5.3']);
    expect(receipt).toMatchObject({
      schema_version: 'juno_benchmark_workflow_readiness.v1',
      boundary: { transport: 'synthetic', protocol: 'juno_benchmark_workflow_process_boundary.v1' },
      operations: ['probe', 'preflight', 'dispatch', 'reconcile', 'resume', 'judge'],
      providers: ['openai-codex', 'zai'],
      models: [
        { selector: ':mini', model: 'openai-codex/gpt-5.6-terra', provider: 'openai-codex', authenticated: true },
        { selector: 'zai/glm-5.3', model: 'zai/glm-5.3', provider: 'zai', authenticated: true },
      ],
      yylo: { executable: fakeYy, version: JUNO_VERSION },
      registry: { backend: 'local', root: path.join(root, '.juno_task', 'artifacts', 'yylo-benchmark') },
      dispatch_count: 0,
    });
    expect(typeof receipt.receipt_hash).toBe('string');
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY|credential/u);
    const manifest = await readFile(path.join(root, '.juno_task', 'artifacts', 'yylo-benchmark', 'experiments', 'boundary-readiness', 'manifest.json'), 'utf8');
    expect(manifest).toContain('boundary-readiness-receipt');
  });

  it('fails closed when live credentials are absent and stays honest about transport', async () => {
    await capture(root, ['setup']);
    await expect(runCli(['readiness', '--models', ':mini'], { cwd: root })).rejects.toThrow(/OPENAI_CODEX_TOKEN/u);
  });

  it('authenticates live readiness from a valid Pi agent auth store entry without an environment credential', async () => {
    await capture(root, ['setup']);
    const store = path.join(root, 'agent-auth.json');
    await writeFile(store, `${JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 } })}\n`, { mode: 0o600 });
    setEnv('YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH', store);
    const receipt = await capture(root, ['readiness', '--models', ':mini']);
    expect(receipt).toMatchObject({ dispatch_count: 0, boundary: { transport: 'live' }, models: [{ selector: ':mini', model: 'openai-codex/gpt-5.6-terra', provider: 'openai-codex', authenticated: true }] });
    expect(JSON.stringify(receipt)).not.toMatch(/TOKEN|SECRET|PASSWORD|API_KEY|credential/u);
  });

  it('fails closed when the installed boundary bytes drift', async () => {
    await capture(root, ['setup', '--synthetic']);
    const installed = path.join(root, '.juno_task', 'boundary', 'yylo-workflow-boundary.mjs');
    await chmod(installed, 0o644);
    await writeFile(installed, 'export {};');
    await expect(runCli(['readiness', '--models', ':mini'], { cwd: root })).rejects.toThrow(/drifted from the reviewed setup digest/u);
  });

  it('fails closed when the live registry root diverges from the setup record', async () => {
    await capture(root, ['setup', '--synthetic']);
    setEnv('YYLO_BENCHMARK_REGISTRY', path.join(root, 'other-registry'));
    await expect(runCli(['readiness', '--models', ':mini'], { cwd: root })).rejects.toThrow(/does not match the setup record/u);
  });
});

describe('installed synthetic lifecycle through the public CLI', () => {
  it('runs setup -> plan -> dry-run -> readiness -> run -> recovery -> rejudge with zero provider dispatch', async () => {
    const setupReceipt = await capture(root, ['setup', '--synthetic']);
    const environment = setupReceipt.environment as { YYLO_BENCHMARK_WORKFLOW_BOUNDARY: string; YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: string };
    setEnv('YYLO_BENCHMARK_WORKFLOW_BOUNDARY', environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY);
    setEnv('YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256', environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256);

    const readiness = await capture(root, ['readiness', '--models', ':mini,zai/glm-5.3']);
    expect(readiness.dispatch_count).toBe(0);

    const plan = await capture(root, ['plan', '--workflow', 'workflow.yaml', '--steps-file', 'policy.yaml', '--models', ':mini,zai/glm-5.3', '--var', 'run_date=2026-08-19', '--output', 'plan.json', '--dry-run']);
    expect(plan).toMatchObject({ schema_version: 'juno_benchmark_workflow_plan.v2', selected_step_ids: ['analyze', 'compute'] });
    expect(plan.runtime_binding).toMatchObject({ juno_version: JUNO_VERSION, boundary: { protocol: 'juno_benchmark_workflow_process_boundary.v1', sha256: `sha256:${environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256}` } });

    const dryRun = await capture(root, ['run', '--plan', 'plan.json', '--steps-file', 'policy.yaml', '--dry-run']);
    expect(dryRun).toMatchObject({ dispatch_count: 0, production_models_sequential: true });

    const run = await capture(root, ['run', '--plan', 'plan.json', '--steps-file', 'policy.yaml']);
    expect(run).toMatchObject({ plan_id: plan.plan_id, recovered: false, candidate_dispatch_count: 4, judge_dispatch_count: 4, production_effect_count: 0 });
    expect((run.terminals as unknown[]).length).toBe(4);
    for (const terminal of run.terminals as Array<{ result: { observed_model: string; observed_provider: string } }>) {
      expect(terminal.result.observed_model.split('/')[0]).toBe(terminal.result.observed_provider);
    }
    const receipts = await readWorkflowEvidenceReceipts(new ImmutableArtifactRegistry(path.join(root, '.juno_task/artifacts/yylo-benchmark')),
      `workflow-${String(plan.plan_id).slice(7)}`);
    const judgeSessions = receipts.map((receipt) => receipt.judge_outcome).map(async (judgement) => {
      const envelope = JSON.parse((await new ImmutableArtifactRegistry(path.join(root, '.juno_task/artifacts/yylo-benchmark')).read(judgement.envelope_ref)).toString('utf8')) as { session_id: string };
      return envelope.session_id;
    });
    expect(new Set(await Promise.all(judgeSessions)).size).toBe(4);
    expect(receipts.every((receipt) => receipt.judge_outcome.valid && receipt.judge_outcome.justification_hash === receipt.judge_outcome.justification_ref.sha256)).toBe(true);

    const rerun = await capture(root, ['run', '--plan', 'plan.json', '--steps-file', 'policy.yaml']);
    expect(rerun).toMatchObject({ plan_id: plan.plan_id, recovered: true, candidate_dispatch_count: 0, judge_dispatch_count: 0, production_effect_count: 0 });

    const recover = await capture(root, ['recover', '--plan', 'plan.json', '--steps-file', 'policy.yaml']);
    expect(recover).toMatchObject({ operation: 'recover', plan_id: plan.plan_id, recovered: true, candidate_dispatch_count: 0, judge_dispatch_count: 0, production_effect_count: 0 });

    const rejudge = await capture(root, ['rejudge', '--plan', 'plan.json', '--steps-file', 'policy.yaml']);
    expect(rejudge).toMatchObject({ schema_version: 'juno_benchmark_workflow_rejudge.v1', plan_id: plan.plan_id,
      candidate_dispatch_count: 0, judge_dispatch_count: 0,
      boundary: { protocol: 'juno_benchmark_workflow_process_boundary.v1', sha256: `sha256:${environment.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256}` } });

    // Synthetic transport spawns no step children at all: the deterministic
    // tracked script never ran, proving zero external effect from acceptance.
    await expect(readFile(path.join(root, 'track-ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
