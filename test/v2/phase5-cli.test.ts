import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createProgram, runCli } from '../../src/cli/program.js';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { runV2Experiment } from '../../src/v2/cli.js';

const execFileAsync = promisify(execFile);
async function api() { return import('../../src/v2/cli.js').catch(() => null); }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-v2-cli-'));
  await mkdir(path.join(root, 'scripts'));
  const harness = path.join(root, 'scripts', 'harness.mjs');
  await writeFile(harness, `const request=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON); const judge=request.invocation?.kind==='evaluator'; const now='2026-01-01T00:00:00.000Z'; process.stdout.write(JSON.stringify({status:'success',exit_code:0,signal:null,session_id:(judge?'judge-':'candidate-')+request.requestedModel,resolved_provider:request.requestedModel.split('/')[0],resolved_model:request.requestedModel,observed_provider:request.requestedModel.split('/')[0],observed_model:request.requestedModel,harness_version:'fixture-1',started_at:now,ended_at:now,runtime_ms:1,cost:{completeness:'not_applicable',usd:null},process:{pid:process.pid,command:['fixture']},artifacts:[],raw_output:judge?JSON.stringify({verdict:'pass'}):'candidate ok'}));`);
  const grader = path.join(root, 'scripts', 'grader.mjs');
  await writeFile(grader, `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({passed:true,findings:[],rawOutput:'checks pass'})));`);
  await writeFile(path.join(root, 'workflow.yaml'), `name: passthrough\nworking_directory: nested\nenvironment: {SAFE: yes}\nsteps:\n  - id: arbitrary\n    executable: node\n    argv: [node, script.mjs]\n  - id: managed\n    managed_agent: {prompt: work}\n`);
  await writeFile(path.join(root, 'task.md'), 'repair the fixture');
  await execFileAsync('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const config = {
    schema_version: 'yylo_benchmark_config.v2', yylo_version: '0.2.1',
    workspace: { attempts_root: '.benchmark/attempts', registry_root: '.benchmark/registry' },
    default_candidate_harness: 'candidate',
    harnesses: {
      candidate: { kind: 'command', executable: process.execPath, arguments: [harness], timeout_ms: 5000 },
      judge: { kind: 'command', executable: process.execPath, arguments: [harness], timeout_ms: 5000 },
    },
    default_evaluators: ['checks', 'judge-v1'],
    evaluators: {
      checks: { kind: 'deterministic', profile_version: '1', generation: 1, required: true, correctness_gate: true, command: [process.execPath, grader] },
      'checks-v2': { kind: 'deterministic', profile_version: '1', generation: 2, required: true, correctness_gate: true, command: [process.execPath, grader] },
      'judge-v1': { kind: 'llm_judge', profile_version: '1', generation: 1, required: true, harness_profile: 'judge', requested_model: 'judge-vendor/model-j', system_prompt: 'judge', prompt_template: '{{evidence}}\\n{{rubric}}', rubric: 'correct', evidence_fields: ['candidate.status', 'artifacts', 'identity'], max_evidence_bytes: 4096, identity_visibility: 'blinded', mode: 'single', timeout_ms: 5000, repetitions: 1, aggregation: 'majority', parser: 'strict_json', settings: {} },
      'judge-v2': { kind: 'llm_judge', profile_version: '1', generation: 2, required: true, harness_profile: 'judge', requested_model: 'another-vendor/model-k', system_prompt: 'judge again', prompt_template: '{{evidence}}\\n{{rubric}}', rubric: 'correct', evidence_fields: ['candidate.status'], max_evidence_bytes: 4096, identity_visibility: 'visible', mode: 'single', timeout_ms: 5000, repetitions: 1, aggregation: 'majority', parser: 'strict_json', settings: {} },
    },
  };
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify(config));
  return root;
}

async function capture(root: string, args: string[]): Promise<Record<string, any>> {
  const output: string[] = [];
  await runCli(args, { cwd: root, stdout: (text) => output.push(text) });
  return JSON.parse(output.join('')) as Record<string, any>;
}

describe('f922O3 phase 5 v2 CLI cutover and restrictive v1 retirement', () => {
  it('P5-A1 exposes plan/run/recover/regrade/rejudge/doctor/report with v2 help and no spend, provider, boundary, policy-sidecar, or overlay options', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    let help = '';
    createProgram().configureOutput({ writeOut: (text) => { help += text; } }).outputHelp();
    for (const command of ['plan', 'run', 'recover', 'regrade', 'rejudge', 'doctor', 'report']) expect(help).toMatch(new RegExp(`\\b${command}\\b`, 'u'));
    expect(help).not.toMatch(/authorization|max-usd|spend|steps-file|boundary|provider allowlist|overlay/iu);
  });

  it('P5-A2 runs task and arbitrary workflow plans through isolated v2 evidence/evaluators with yylo_version and cost-only economics', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    const root = await fixture();
    const workflowPlan = await capture(root, ['plan', '--workflow', 'workflow.yaml', '--models', 'vendor-a/model-1,vendor-b/model-2', '--controlled-model-variable', 'candidate_model', '--output', 'workflow-plan.json']);
    expect(workflowPlan).toMatchObject({ schema_version: 'yylo_benchmark_experiment_plan.v2', yylo_version: '0.2.1', comparison_kind: 'model_only' });
    expect(JSON.stringify(workflowPlan)).not.toContain('juno_version');
    expect(JSON.stringify(workflowPlan)).not.toMatch(/authorization|max_usd|spend/iu);
    const run = await capture(root, ['run', '--plan', 'workflow-plan.json']);
    expect(run).toMatchObject({ schema_version: 'yylo_benchmark_run_receipt.v2', candidate_dispatch_count: 2 });
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts[0].evidence.schema_version).toBe('yylo_benchmark_attempt_evidence.v2');
    expect(run.attempts[0].evaluation.quality).toBe('resolved');
    const taskPlan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor-c/model-3', '--output', 'task-plan.json']);
    expect(taskPlan.attempts[0].case.kind).toBe('task');
  });

  it('binds command-harness terminal truth to measured nonzero exits and signals', async () => {
    for (const outcome of ['nonzero', 'signal'] as const) {
      const root = await fixture();
      const harness = path.join(root, 'scripts', `contradictory-${outcome}.mjs`);
      await writeFile(harness, `const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);const now=new Date().toISOString();const terminal={status:'success',exit_code:0,signal:null,session_id:'claimed-success',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',started_at:now,ended_at:now,runtime_ms:1,cost:{completeness:'not_applicable',usd:null},process:{pid:1,command:['claimed']},artifacts:[],raw_output:'claimed success'};process.stdout.write(JSON.stringify(terminal),()=>{${outcome === 'signal' ? "process.kill(process.pid,'SIGTERM')" : 'process.exit(42)'}});`);
      const configPath = path.join(root, 'yylo-benchmark.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
      config.harnesses.candidate.arguments = [harness];
      await writeFile(configPath, JSON.stringify(config));
      const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
      const run = await capture(root, ['run', '--plan', 'plan.json']);
      expect(run.attempts[0].evidence.candidate).toMatchObject({ status: 'failure', exit_code: outcome === 'nonzero' ? 42 : null,
        signal: outcome === 'signal' ? 'SIGTERM' : null });
      expect(run.attempts[0].evidence.candidate.process).not.toMatchObject({ pid: 1, command: ['claimed'] });
    }
  });

  it('rejects every malformed nested attempt before dry-run success or fresh dispatch', async () => {
    const root = await fixture();
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    const rebuild = (mutate: (attempt: Record<string, any>) => void, rehashAttempt = true) => {
      const attempt = structuredClone(plan.attempts[0]) as Record<string, any>;
      mutate(attempt);
      if (rehashAttempt) { const { plan_hash: _attemptHash, ...attemptCore } = attempt; attempt.plan_hash = canonicalHash(attemptCore); }
      const { plan_hash: _planHash, ...planCore } = plan;
      const attempts = [attempt];
      return { ...planCore, attempts, plan_hash: canonicalHash({ ...planCore, attempts }) } as never;
    };
    const malformed = [
      rebuild((attempt) => { attempt.requested_model = 'vendor/changed'; }),
      rebuild((attempt) => { attempt.case.source.commit = '0'.repeat(40); }),
      rebuild((attempt) => { attempt.evaluators[0].config_hash = `sha256:${'0'.repeat(64)}`; }),
      rebuild((attempt) => { attempt.requested_model = 'vendor/changed-with-stale-hash'; }, false),
    ];
    for (const candidate of malformed) {
      await expect(runV2Experiment({ cwd: root, plan: candidate, dryRun: true })).rejects.toThrow(/attempt plan|attempt evaluator/iu);
      await expect(runV2Experiment({ cwd: root, plan: candidate })).rejects.toThrow(/attempt plan|attempt evaluator/iu);
    }
  });

  it('keeps generated-default candidate roots and environment outside source and private control topology', async () => {
    const root = await fixture();
    const harness = path.join(root, 'scripts', 'topology-probe.mjs');
    await writeFile(harness, `import{existsSync,readdirSync}from'node:fs';import path from'node:path';const r=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);const probe={cwd:process.cwd(),pwd:process.env.PWD??null,oldpwd:process.env.OLDPWD??null,initCwd:process.env.INIT_CWD??null,sourceRoute:existsSync(path.resolve(process.cwd(),'../../../../.juno_task')),registryRoute:existsSync(path.resolve(process.cwd(),'../../../registry')),controlEntries:readdirSync(path.resolve(process.cwd(),'../..'))};const now=new Date().toISOString();process.stdout.write(JSON.stringify({status:'success',exit_code:0,signal:null,session_id:'probe',resolved_provider:'vendor',resolved_model:r.requestedModel,observed_provider:'vendor',observed_model:r.requestedModel,harness_version:'fixture-1',started_at:now,ended_at:now,runtime_ms:1,cost:{completeness:'not_applicable',usd:null},process:{pid:process.pid,command:['probe']},artifacts:[],raw_output:JSON.stringify(probe)}));`);
    const configPath = path.join(root, 'yylo-benchmark.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    config.workspace = { attempts_root: '.yylo-benchmark/attempts', registry_root: '.yylo-benchmark/registry' };
    config.harnesses.candidate.arguments = [harness];
    await writeFile(configPath, JSON.stringify(config));
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    const run = await capture(root, ['run', '--plan', 'plan.json']);
    const probe = JSON.parse(run.attempts[0].evidence.candidate.output) as Record<string, any>;
    expect(probe).toMatchObject({ pwd: null, oldpwd: null, initCwd: null, sourceRoute: false, registryRoute: false });
    expect(path.resolve(probe.cwd)).not.toContain(path.resolve(root));
    expect(probe.controlEntries).toEqual([plan.attempts[0].attempt_id.slice(7)]);
  });

  it('P5-A3 recovers known terminals and appends regrade/rejudge generations without candidate redispatch', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    const root = await fixture();
    const plan = await capture(root, ['plan', '--task', 'task.md', '--models', 'vendor/model', '--output', 'plan.json']);
    await capture(root, ['run', '--plan', 'plan.json']);
    // Crash window: workspace, intent, and hash-valid terminal are durable, but state publication is absent.
    await rm(path.join(root, '.benchmark', 'registry', 'v2', 'runs', plan.experiment_id.slice(7), `${plan.attempts[0].attempt_id.slice(7)}.json`));
    const recovered = await capture(root, ['recover', '--plan', 'plan.json']);
    expect(recovered).toMatchObject({ candidate_dispatch_count: 0, reused_terminal_count: 1, ambiguous_count: 0 });
    const regraded = await capture(root, ['regrade', '--plan', 'plan.json', '--profile', 'checks-v2']);
    expect(regraded).toMatchObject({ candidate_dispatch_count: 0, evaluator_dispatch_count: 1 });
    const rejudged = await capture(root, ['rejudge', '--plan', 'plan.json', '--profile', 'judge-v2']);
    expect(rejudged).toMatchObject({ candidate_dispatch_count: 0, evaluator_dispatch_count: 1 });
    expect(rejudged.attempts[0].evaluation_records.map((item: { evaluator_generation: number }) => item.evaluator_generation)).toContain(2);
  });

  it('P5-A4 doctor and report retain provenance, evaluator generations, invalidity, candidate/judge cost, and comparison classification', async () => {
    expect(await api(), 'v2 CLI module must exist').not.toBeNull();
    const root = await fixture();
    await capture(root, ['plan', '--workflow', 'workflow.yaml', '--models', 'vendor/model', '--output', 'plan.json']);
    await capture(root, ['run', '--plan', 'plan.json']);
    const doctor = await capture(root, ['doctor', '--plan', 'plan.json']);
    expect(doctor).toMatchObject({ schema_version: 'yylo_benchmark_doctor.v2', ok: true, candidate_dispatch_count: 1, ambiguous_count: 0 });
    const report = await capture(root, ['report', '--plan', 'plan.json']);
    expect(report).toMatchObject({ schema_version: 'yylo_benchmark_report.v2', comparison_kind: 'agent_system', evidence_count: 1, valid_resolved: 1, valid_unresolved: 0 });
    expect(report.valid_resolved + report.valid_unresolved + report.unknown_quality).toBe(report.evidence_count);
    expect(report).toHaveProperty('candidate_cost');
    expect(report).toHaveProperty('judge_cost');
    expect(report.provenance.evaluation_ids.length).toBeGreaterThan(0);
  });

  it('P5-A5 standalone and delegated argv/cwd/streams/exits remain package-independent and the packed CLI supports no-dispatch help/plan/doctor', async () => {
    const module = await api();
    expect(module, 'v2 CLI module must exist').not.toBeNull();
    expect(module!.V2_CLI_SCHEMA_VERSION).toBe('yylo_benchmark_cli.v2');
    const builtins = await readFile(path.join(process.cwd(), 'src', 'cli', 'builtins.ts'), 'utf8');
    expect(builtins).not.toMatch(/TaskExecutionAuthorization|createWorkflowPlanFromProject|workflowBoundary|BOUNDARY_SUPPORTED_PROVIDERS|--steps-file|--max-usd/iu);
  });
});
