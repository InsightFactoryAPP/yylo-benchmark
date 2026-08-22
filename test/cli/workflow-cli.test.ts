import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProgram, runCli } from '../../src/cli/program.js';

const rubric = `sha256:${'a'.repeat(64)}`;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-cli-'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  await writeFile(path.join(root, 'workflow.yaml'), `schema_version: 2\nworkflow_id: cli-fixture\nsteps:\n  - id: analyze\n    command: [yy, pi, "Analyze without rewriting this prompt"]\n`);
  await writeFile(path.join(root, 'policy.yaml'), JSON.stringify({
    schema_version: 'juno_benchmark_workflow_policy.v1',
    judge: { judge_id: 'governed-binary', judge_version: '1', model: 'openai-codex/gpt-5.6-sol', rubric_hash: rubric },
    authorization: { authorization_id: 'fixture-required', production: true, spend: true },
    recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 },
    redaction: { secret_patterns: ['TOKEN'], retain_prompts: false },
    estimates: { models: [{ model: 'openai-codex/gpt-5.6-sol', candidate_usd: 1, judge_usd: 0.25, runtime_ms: 1000 }] },
    steps: [{ step_id: 'analyze', scoring_id: 'analyze-score', side_effect: 'production',
      resources: [{ type: 'production', id: 'FIXTURE_BACKEND', access: 'exclusive' }],
      limits: { timeout_ms: 1000, max_usd: 1 }, authorization: 'production_and_spend', recovery: 'manual',
      redaction: { patterns: ['TOKEN'], retain_prompt: false } }],
  }));
  await writeFile(path.join(root, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':sol'] }));
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify({ schema_version: 'juno_benchmark_config.v1', repository_id: 'cli-fixture', model_aliases: { ':sol': 'openai-codex/gpt-5.6-sol' } }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'workflow.yaml'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

async function capture(root: string, args: string[]): Promise<Record<string, unknown>> {
  const output: string[] = [];
  await runCli(args, { cwd: root, stdout: (text) => output.push(text) });
  return JSON.parse(output.join('')) as Record<string, unknown>;
}

async function boundary(root: string): Promise<{ module: string; sha256: string }> {
const module = path.join(root, 'reviewed-workflow-boundary.mjs');
  const source = `import { readFileSync } from 'node:fs';
const operation = process.argv[2];
const payload = JSON.parse(readFileSync(3, 'utf8'));
const input = operation === 'probe' ? payload : payload.invocation;
const terminal = () => ({ dispatch_id: input.dispatch_id, status: 'success', effect: 'completed',
  runner_run_id: 'runner-' + input.step_id, observed_provider: input.provider, observed_model: input.model,
  evidence: { outer_session_id: 'outer-' + input.step_id, nested_session_ids: ['nested-' + input.step_id],
    started_at: '2026-08-12T00:00:00.000Z', ended_at: '2026-08-12T00:00:01.000Z', runtime_ms: 1000,
    cost: { completeness: 'complete', usd: 0.5 }, candidate_outcome: { status: 'success' },
    harness_validity: { status: 'valid', reason: null }, transcript: 'synthetic retained truth', artifacts: { result: 'ok' } } });
let output;
if (operation === 'probe') output = { schema_version: 'juno_benchmark_workflow_process_boundary.v1', providers: ['openai-codex'] };
else if (operation === 'preflight') output = { ok: true };
else if (operation === 'dispatch' || operation === 'resume') output = terminal();
else if (operation === 'reconcile') output = { state: 'proven_not_dispatched' };
else if (operation === 'judge') output = { resolved: true, evidence: 'governed synthetic judgement' };
else throw new Error('unsupported operation');
process.stdout.write(JSON.stringify(output));
`;
  await writeFile(module, source);
  return { module: await realpath(module), sha256: createHash('sha256').update(source).digest('hex') };
}

describe('generic workflow CLI lifecycle', () => {
  it('advertises accurate standalone help without a daily-ops command', () => {
    let help = '';
    createProgram().configureOutput({ writeOut: (text) => { help += text; } }).outputHelp();
    for (const command of ['plan', 'run', 'recover', 'rejudge']) expect(help).toMatch(new RegExp(`\\b${command}\\b`, 'u'));
    expect(help).not.toMatch(/daily-ops/u);
  });

  it('plans, runs, recovers, and rejudges read-only with immutable zero-dispatch output', async () => {
    const root = await fixture();
    const plan = await capture(root, ['plan', '--workflow', 'workflow.yaml', '--steps-file', 'policy.yaml', '--models', ':sol', '--output', 'plan.json', '--dry-run']);
    expect(plan).toMatchObject({ schema_version: 'juno_benchmark_workflow_plan.v1', selected_step_ids: ['analyze'] });

    const run = await capture(root, ['run', '--plan', 'plan.json', '--steps-file', 'policy.yaml', '--dry-run']);
    expect(run).toMatchObject({ schema_version: 'juno_benchmark_workflow_dry_run.v1', dispatch_count: 0,
      production_models_sequential: true, required_resources: [{ type: 'production', id: 'FIXTURE_BACKEND' }],
      estimated_totals: { usd: 1.25, runtime_ms: 1000 },
      cost_tracking: { mode: 'best_effort', unavailable_is_valid: true } });
    expect(run.immutable_hashes).toMatchObject({ plan: plan.plan_id });

    const recover = await capture(root, ['recover', '--plan', 'plan.json', '--steps-file', 'policy.yaml', '--dry-run']);
    expect(recover).toMatchObject({ operation: 'recover', dispatch_count: 0, plan_id: plan.plan_id });
    const rejudge = await capture(root, ['rejudge', '--plan', 'plan.json', '--steps-file', 'policy.yaml', '--dry-run']);
    expect(rejudge).toMatchObject({ operation: 'rejudge', candidate_dispatch_count: 0, judge_dispatch_count: 0, plan_id: plan.plan_id });
    expect(await readFile(path.join(root, 'workflow.yaml'), 'utf8')).toContain('Analyze without rewriting this prompt');
  });

  it('runs, recovers, and rejudges through one hash-pinned reviewed CLI boundary', async () => {
    const root = await fixture(); const reviewed = await boundary(root);
    const plan = await capture(root, ['plan', '--workflow', 'workflow.yaml', '--steps-file', 'policy.yaml', '--models', ':sol', '--output', 'plan.json', '--dry-run']);
    const priorModule = process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY'];
    const priorHash = process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256'];
    process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY'] = reviewed.module;
    process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256'] = reviewed.sha256;
    try {
      const run = await capture(root, ['run', '--plan', 'plan.json', '--steps-file', 'policy.yaml']);
      expect(run).toMatchObject({ plan_id: plan.plan_id, recovered: false, terminals: [{ step_id: 'analyze', result: { status: 'success' } }] });
      const recover = await capture(root, ['recover', '--plan', 'plan.json', '--steps-file', 'policy.yaml']);
      expect(recover).toMatchObject({ operation: 'recover', plan_id: plan.plan_id, recovered: true });
      const rejudge = await capture(root, ['rejudge', '--plan', 'plan.json', '--steps-file', 'policy.yaml', '--judge', ':sol']);
      expect(rejudge).toMatchObject({ schema_version: 'juno_benchmark_workflow_rejudge.v1', plan_id: plan.plan_id,
        candidate_dispatch_count: 0, judge_dispatch_count: 1,
        boundary: { protocol: 'juno_benchmark_workflow_process_boundary.v1', sha256: `sha256:${reviewed.sha256}` } });
      const secondRejudge = await capture(root, ['rejudge', '--plan', 'plan.json', '--steps-file', 'policy.yaml', '--judge', ':sol']);
      expect(secondRejudge).toMatchObject({ schema_version: 'juno_benchmark_workflow_rejudge.v1', plan_id: plan.plan_id,
        candidate_dispatch_count: 0, judge_dispatch_count: 1 });
    } finally {
      if (priorModule === undefined) delete process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY']; else process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY'] = priorModule;
      if (priorHash === undefined) delete process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256']; else process.env['YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256'] = priorHash;
    }
  });

  it('rejects unknown, malformed, and invalid invocations actionably', async () => {
    await expect(runCli(['daily-ops'])).rejects.toThrow(/unknown command.*--help/u);
    const root = await fixture();
    await writeFile(path.join(root, 'bad-plan.json'), '{broken');
    await expect(runCli(['run', '--plan', 'bad-plan.json', '--steps-file', 'policy.yaml', '--dry-run'], { cwd: root }))
      .rejects.toThrow(/cannot read benchmark plan/u);
    await expect(runCli(['recover', '--plan', 'bad-plan.json', '--steps-file', 'policy.yaml'], { cwd: root }))
      .rejects.toThrow(/cannot read benchmark plan/u);

    const program = createProgram().configureOutput({ writeErr: () => undefined });
    program.commands.find((item) => item.name() === 'plan')!.exitOverride();
    await expect(program.parseAsync(['plan', '--task', 'T1', '--workflow', 'workflow.yaml', '--models', ':sol'], { from: 'user' }))
      .rejects.toMatchObject({ code: 'commander.conflictingOption' });
    await expect(runCli(['plan', '--workflow', 'workflow.yaml', '--steps-file', 'policy.yaml', '--models', ':sol', '--max-usd', '0'], { cwd: root }))
      .rejects.toThrow(/applies only to legacy task-case plans/u);
  });
});
