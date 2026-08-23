#!/usr/bin/env node
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const repository = args.get('--repository');
const benchmark = args.get('--benchmark');
const delegate = args.get('--delegate');
if (!repository || !benchmark) {
  process.stderr.write('usage: node verify-convert-installed-acceptance.mjs --repository <Convert git checkout> --benchmark <installed yylo-benchmark> [--delegate <installed yy>]\n');
  process.exit(2);
}

const fixtureRoot = path.join(packageRoot, 'fixtures', 'convert-2026-08-12');
const expected = JSON.parse(await readFile(path.join(fixtureRoot, 'expected.json'), 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 'yylo-benchmark-convert-acceptance-'));
const project = path.join(temporary, 'project');
const planPath = path.join(project, 'historical-plan.json');

function execute(executable, commandArgs, cwd = project) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^YYLO_BENCHMARK_(?:AUTH|REGISTRY|WORK_ROOT)/u.test(key) && !/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/u.test(key)));
  env.PATH = `${path.dirname(path.resolve(benchmark))}${path.delimiter}${env.PATH ?? ''}`;
  const result = spawnSync(executable, commandArgs, { cwd, env, encoding: 'utf8', input: '', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`${executable} ${commandArgs.join(' ')} failed (${result.error?.message ?? result.status ?? result.signal}): ${result.stderr || result.stdout}`);
  }
  return result;
}
function json(result) { return JSON.parse(result.stdout); }
function same(actual, wanted, label) {
  try { deepStrictEqual(actual, wanted); }
  catch { throw new Error(`${label} mismatch: ${JSON.stringify({ actual, wanted })}`); }
}
function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

try {
  execute('git', ['clone', '--shared', '--no-checkout', path.resolve(repository), project], temporary);
  execute('git', ['checkout', '--detach', expected.historical_source_commit]);
  await mkdir(path.join(project, '.juno_task'), { recursive: true });
  await writeFile(path.join(project, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':sol', ':mini', ':luna', 'zai/glm-5.2'] }));
  await writeFile(path.join(project, 'yylo-benchmark.config.json'), JSON.stringify({
    schema_version: 'juno_benchmark_config.v1', repository_id: 'convert_IF_chat',
    model_aliases: { ':sol': 'openai-codex/gpt-5.6-sol', ':mini': 'openai-codex/gpt-5.6-terra', ':luna': 'openai-codex/gpt-5.6-luna' },
  }));
  const policyPath = path.join(project, 'convert-2026-08-12.policy.yaml');
  await cp(path.join(fixtureRoot, 'policy.yaml'), policyPath);
  const rubric = await readFile(path.join(fixtureRoot, 'rubric.md'));
  if (sha256(rubric) !== expected.judge.rubric_hash) throw new Error('packaged governed rubric hash mismatch');

  const planArgs = ['plan', '--workflow', expected.workflow_path, '--steps-file', path.basename(policyPath),
    '--steps', expected.selected_step_ids.join(','), '--models', ':sol,:mini,:luna,zai/glm-5.2', '--var', `run_date=${expected.historical_date}`, '--attempts', '1', '--dry-run'];
  const standalonePlanResult = execute(benchmark, planArgs); const plan = json(standalonePlanResult);
  await writeFile(planPath, `${standalonePlanResult.stdout.trim()}\n`, { mode: 0o600 });
  same(plan.source, {
    repository_id: 'convert_IF_chat', source_ref: expected.historical_source_ref, source_commit: expected.historical_source_commit,
    workflow_path: expected.workflow_path, raw_sha256: expected.workflow_raw_sha256, semantics_sha256: expected.workflow_semantics_sha256,
  }, 'historical source identity');
  same(plan.selected_step_ids, expected.selected_step_ids, 'historical stable step selection');
  same(plan.models, expected.models, 'exact model identities');
  same(plan.model_dispatch_step_ids, expected.injection_step_ids, 'canonical model-dispatch classification');
  if (plan.spend_limits !== undefined) throw new Error('workflow plan must not carry spend limits; cost is observational evidence only');
  same(plan.policy.judge, expected.judge, 'governed judge');
  if (plan.normalized_workflow.steps.length !== expected.current_step_count) throw new Error('historical 13-of-17 distinction is invalid');
  const sourceCommands = new Map(plan.normalized_workflow.steps.map((step) => [step.id, step.command]));
  same(plan.policy.deterministic_commands.map((item) => item.step_id), expected.deterministic_step_ids, 'deterministic command policy');
  for (const compiled of plan.compiled_workflows) {
    same(compiled.injected_step_ids, expected.injection_step_ids, `injection points for ${compiled.model}`);
    const compiledWorkflow = JSON.parse(JSON.stringify((await import('yaml')).parse(Buffer.from(compiled.workflow_bytes_base64, 'base64').toString('utf8'))));
    for (const stepId of expected.deterministic_step_ids) {
      same(compiledWorkflow.steps.find((step) => step.id === stepId).command, sourceCommands.get(stepId), `deterministic argv for ${compiled.model}/${stepId}`);
    }
  }
  same(plan.execution_order.map((item) => `${item.model}:${item.attempt}:${item.step_id}`),
    expected.models.flatMap((model) => expected.selected_step_ids.map((step) => `${model}:1:${step}`)), 'strict sequential execution order');

  const operations = [
    ['run', '--plan', path.basename(planPath), '--steps-file', path.basename(policyPath), '--dry-run'],
    ['recover', '--plan', path.basename(planPath), '--steps-file', path.basename(policyPath), '--dry-run'],
    ['rejudge', '--plan', path.basename(planPath), '--steps-file', path.basename(policyPath), '--dry-run'],
  ];
  const standalone = operations.map((operation) => execute(benchmark, operation));
  if (delegate) {
    const delegatedPlan = execute(delegate, ['benchmark', ...planArgs]);
    if (delegatedPlan.stdout !== standalonePlanResult.stdout || delegatedPlan.stderr !== standalonePlanResult.stderr) throw new Error('delegated historical plan differs from standalone');
    operations.forEach((operation, index) => {
      const delegated = execute(delegate, ['benchmark', ...operation]);
      if (delegated.stdout !== standalone[index].stdout || delegated.stderr !== standalone[index].stderr) throw new Error(`delegated ${operation[0]} differs from standalone`);
    });
  }

  const dryRun = json(standalone[0]);
  if (dryRun.dispatch_count !== expected.dispatch_expected || dryRun.production_models_sequential !== true) throw new Error('installed dry-run dispatch/sequential contract failed');
  if ('authorization' in dryRun) throw new Error('dry-run must not report spend authorization; grants were removed in favor of observational cost');
  same(dryRun.cost_tracking, { mode: 'best_effort', unavailable_is_valid: true }, 'observational cost tracking');
  same(dryRun.models, expected.models, 'dry-run models');
  same(dryRun.selected_step_ids, expected.selected_step_ids, 'dry-run selected steps');
  same(dryRun.judge, expected.judge, 'dry-run judge');
  same(dryRun.required_resources.map((item) => `${item.type}:${item.id}`).sort(), [...expected.resources].sort(), 'typed resources');
  same(dryRun.estimated_totals, { usd: expected.estimated_total_usd, runtime_ms: expected.estimated_total_runtime_ms }, 'estimates');
  same(dryRun.immutable_hashes, { plan: plan.plan_id, workflow_raw: expected.workflow_raw_sha256,
    workflow_semantics: expected.workflow_semantics_sha256, policy_raw: plan.policy_raw_sha256,
    policy_semantics: plan.policy_semantics_sha256, variables: plan.variables_hash }, 'immutable hashes');
  if (json(standalone[1]).dispatch_count !== 0 || json(standalone[2]).candidate_dispatch_count !== 0 || json(standalone[2]).judge_dispatch_count !== 0) throw new Error('recover/rejudge dry-run dispatched work');
  try { await stat(path.join(project, '.juno_task', 'artifacts')); throw new Error('read-only installed acceptance created retained artifacts'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  process.stdout.write(`${JSON.stringify({ schema_version: 'juno_benchmark_convert_installed_acceptance.v1', plan_id: plan.plan_id, dispatch_count: 0, source_commit: expected.historical_source_commit })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
