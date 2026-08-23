import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createProgram, runCli } from '../../src/cli/program.js';
import { parseBenchmarkPlan } from '../../src/planning/index.js';
import {
  compileWorkflowOverlay, parseWorkflowBytes, planWorkflowFromProject, verifyWorkflowPlanBindings,
  type WorkflowPolicy,
} from '../../src/workflow/plan.js';

const rubric = `sha256:${'a'.repeat(64)}`;
const workflowText = `schema_version: 2
workflow_id: fixture
steps:
  - id: prepare
    command: [printf, same]
  - id: analyze
    command: [yy, pi, "Keep this prompt --model text unchanged"]
  - id: publish
    command: [echo, done]
`;
const policy = (includeAnalyze = true): WorkflowPolicy => ({
  schema_version: 'juno_benchmark_workflow_policy.v1',
  judge: { judge_id: 'binary', judge_version: '1', model: ':sol', rubric_hash: rubric },
  authorization: { authorization_id: 'offline-fixture', production: false, spend: true },
  recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 0 },
  redaction: { secret_patterns: ['TOKEN'], retain_prompts: false },
  steps: [
    { step_id: 'prepare', scoring_id: 'prepare-score', side_effect: 'none', resources: [], limits: { timeout_ms: 1000, max_usd: 0 }, authorization: 'none', recovery: 'retry_safe', redaction: { patterns: [], retain_prompt: false } },
    ...(includeAnalyze ? [{ step_id: 'analyze', scoring_id: 'analyze-score', side_effect: 'paid' as const, resources: [{ type: 'credential' as const, id: 'MODEL_PROVIDER', access: 'read' as const }], limits: { timeout_ms: 5000, max_usd: 1 }, authorization: 'spend' as const, recovery: 'manual' as const, redaction: { patterns: ['TOKEN'], retain_prompt: false } }] : []),
  ],
});

async function fixture(workflow = workflowText, sidecar: WorkflowPolicy = policy()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-plan-'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  await writeFile(path.join(root, 'workflow.yaml'), workflow);
  await writeFile(path.join(root, 'policy.yaml'), JSON.stringify(sidecar));
  await writeFile(path.join(root, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':sol', 'zai/glm-5.2', ':mini'] }));
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify({ schema_version: 'juno_benchmark_config.v1', repository_id: 'fixture', model_aliases: { ':sol': 'openai-codex/gpt-5.6-sol', ':mini': 'openai-codex/gpt-5.6-terra' } }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'workflow.yaml'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

function input(root: string) {
  return { projectRoot: root, repositoryId: 'fixture', workflowPath: 'workflow.yaml', policyPath: 'policy.yaml',
    models: [':sol', 'zai/glm-5.2'], modelAliases: { ':sol': 'openai-codex/gpt-5.6-sol', ':mini': 'openai-codex/gpt-5.6-terra' },
    junoVersion: '2.1.3-test', attempts: 2, variables: { run_date: '2026-08-12' }, selectedStepIds: ['prepare', 'analyze'] } as const;
}

describe('generic immutable workflow planning', () => {
  it('binds source/policy bytes, stable IDs, aliases, mixed providers, order, and immutable overlays', async () => {
    const root = await fixture(); const plan = await planWorkflowFromProject(input(root));
    expect(parseBenchmarkPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(plan.models).toEqual(['openai-codex/gpt-5.6-sol', 'zai/glm-5.2']);
    expect(plan.model_selectors).toEqual({ 'openai-codex/gpt-5.6-sol': ':sol', 'zai/glm-5.2': 'zai/glm-5.2' });
    expect(plan.selected_step_ids).toEqual(['prepare', 'analyze']);
    expect(plan.model_dispatch_step_ids).toEqual(['analyze']);
    expect('spend_limits' in plan).toBe(false);
    expect(plan.execution_order.map((item) => `${item.model}:${item.attempt}:${item.step_id}`)).toEqual([
      'openai-codex/gpt-5.6-sol:1:prepare', 'openai-codex/gpt-5.6-sol:1:analyze',
      'openai-codex/gpt-5.6-sol:2:prepare', 'openai-codex/gpt-5.6-sol:2:analyze',
      'zai/glm-5.2:1:prepare', 'zai/glm-5.2:1:analyze', 'zai/glm-5.2:2:prepare', 'zai/glm-5.2:2:analyze',
    ]);
    expect(plan.compiled_workflows.map((item) => item.injected_step_ids)).toEqual([['analyze'], ['analyze']]);
    for (const compiled of plan.compiled_workflows) {
      const generated = parse(Buffer.from(compiled.workflow_bytes_base64, 'base64').toString('utf8')) as { steps: Array<{ id: string; command: string[] }> };
      expect(generated.steps[0]!.command).toEqual(['printf', 'same']);
      expect(generated.steps[2]!.command).toEqual(['echo', 'done']);
      expect(generated.steps[1]!.command.slice(-1)).toEqual(['Keep this prompt --model text unchanged']);
      expect(generated.steps[1]!.command.slice(0, 4)).toEqual(['yy', 'pi', '--model', compiled.selector]);
    }
    expect(await readFile(path.join(root, 'workflow.yaml'), 'utf8')).toBe(workflowText);
    await expect(stat(path.join(root, '.juno_task', 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });

    const raw = await readFile(path.join(root, 'workflow.yaml')); const policyRaw = await readFile(path.join(root, 'policy.yaml'));
    expect(() => verifyWorkflowPlanBindings(plan, raw, policyRaw)).not.toThrow();
    expect(() => verifyWorkflowPlanBindings(plan, Buffer.concat([raw, Buffer.from('\n# raw drift\n')]), policyRaw)).toThrow(/raw-byte drift/u);
    expect(() => verifyWorkflowPlanBindings(plan, raw, Buffer.concat([policyRaw, Buffer.from('\n')]))).toThrow(/policy drift/u);
  });

  it('accepts arbitrary exact identities without workflowModels catalogs and rejects malformed or duplicate resolutions', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.juno_task', 'config.json'), '{}\n');
    const arbitrary = { ...input(root), models: [':mini', 'zai/glm-5.3', 'new-valid-provider/new-model.2026-08'], attempts: 1 };
    const plan = await planWorkflowFromProject(arbitrary);
    expect(plan.models).toEqual(['openai-codex/gpt-5.6-terra', 'zai/glm-5.3', 'new-valid-provider/new-model.2026-08']);
    expect(plan.workflow_model_policy.workflow_models).toEqual([]);
    expect(plan.model_selectors['zai/glm-5.3']).toBe('zai/glm-5.3');
    await expect(planWorkflowFromProject({ ...arbitrary, models: [':mini', 'openai-codex/gpt-5.6-terra'] })).rejects.toThrow(/same exact model/u);
    for (const malformed of ['missing-provider', '/model', 'provider/', 'provider/model/extra', 'provider/:alias', 'provider/model name', `provider/model${String.fromCharCode(0)}`]) {
      await expect(planWorkflowFromProject({ ...arbitrary, models: [malformed] })).rejects.toThrow(/exact provider\/model identity/u);
    }
  });

  it('selects only stable IDs and rejects positional drift and missing consequential policy', async () => {
    const root = await fixture();
    await expect(planWorkflowFromProject({ ...input(root), selectedStepIds: ['analyze', 'prepare'] })).rejects.toThrow(/stable source order/u);
    await expect(planWorkflowFromProject({ ...input(root), selectedStepIds: ['missing'] })).rejects.toThrow(/does not exist/u);
    const omitted = await fixture(workflowText, policy(false));
    await expect(planWorkflowFromProject(input(omitted))).rejects.toThrow(/requires policy/u);
    const observational = policy(); observational.authorization.spend = false;
    observational.steps[1] = { ...observational.steps[1]!, side_effect: 'none', authorization: 'none', limits: { timeout_ms: 5000, max_usd: 0 } };
    const observationalRoot = await fixture(workflowText, observational);
    await expect(planWorkflowFromProject(input(observationalRoot))).resolves.toMatchObject({ model_dispatch_step_ids: ['analyze'] });
  });

  it('accepts only matching explicit selectors and closes hidden override channels', () => {
    const explicit = parseWorkflowBytes(Buffer.from(workflowText.replace('[yy, pi,', '[yy, pi, --model, :sol,')));
    expect(() => compileWorkflowOverlay(explicit, ['analyze'], { selector: ':sol', exact: 'openai-codex/gpt-5.6-sol', provider: 'openai-codex', modelName: 'gpt-5.6-sol' }, [':sol'])).not.toThrow();
    expect(() => compileWorkflowOverlay(explicit, ['analyze'], { selector: ':mini', exact: 'openai-codex/gpt-5.6-terra', provider: 'openai-codex', modelName: 'gpt-5.6-terra' }, [':mini'])).toThrow(/conflicts/u);
    const hidden = parseWorkflowBytes(Buffer.from(workflowText.replace('[yy, pi,', '[env, PI_MODEL=evil, yy, pi,')));
    expect(() => compileWorkflowOverlay(hidden, ['analyze'], { selector: ':sol', exact: 'openai-codex/gpt-5.6-sol', provider: 'openai-codex', modelName: 'gpt-5.6-sol' }, [':sol'])).toThrow(/hidden/u);
    const selection = { selector: ':sol', exact: 'openai-codex/gpt-5.6-sol', provider: 'openai-codex', modelName: 'gpt-5.6-sol' };
    const commandWorkflow = (command: string) => parseWorkflowBytes(Buffer.from(
      workflowText.replace('[yy, pi, "Keep this prompt --model text unchanged"]', command),
    ));
    for (const command of [
      '"bash -lc \'yy pi hidden\'"',
      '[bash, script.sh]',
      '[sh, -c, "$AGENT exec"]',
      '[env, SAFE=1, bash, -c, "$AGENT exec"]',
      '[python3, -c, "print(1)"]',
      '[node, -e, "process.exit(0)"]',
      '[nohup, bash, -c, hidden]',
      '[git, status, --short]',
      '[/tmp/attacker/yy, pi, hidden]',
      '[/tmp/attacker/printf, hidden]',
      '[./yy, pi, hidden]',
      '[yy, task, status, T1]',
    ]) {
      expect(() => compileWorkflowOverlay(commandWorkflow(command), ['analyze'], selection, [':sol'])).toThrow(/argument array|approved direct ordinary|canonical yy pi|exact policy binding/u);
    }
    for (const command of ['[printf, safe]', '[echo, safe]']) {
      expect(() => compileWorkflowOverlay(commandWorkflow(command), ['analyze'], selection, [':sol'])).not.toThrow();
    }
  });

  it('binds narrow tracked env/python deterministic commands and rejects policy, argv, and script drift', async () => {
    const deterministicWorkflow = `schema_version: 2
workflow_id: deterministic
steps:
  - id: prepare
    command: [env, PYTHONPATH=., python3, scripts/report.py, --run-date, "{{ run_date }}"]
`;
    const deterministicPolicy: WorkflowPolicy = {
      ...policy(false),
      deterministic_commands: [{ step_id: 'prepare', executable: 'env', environment: [{ name: 'PYTHONPATH', value: '.' }],
        interpreter: 'python3', script: 'scripts/report.py', working_directory: '.' }],
    };
    const root = await fixture(deterministicWorkflow, deterministicPolicy);
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'report.py'), 'print("ok")\n');
    execFileSync('git', ['add', 'scripts/report.py'], { cwd: root });
    execFileSync('git', ['commit', '--amend', '--no-edit'], { cwd: root, stdio: 'ignore' });
    const deterministicInput = { projectRoot: root, repositoryId: 'fixture', workflowPath: 'workflow.yaml', policyPath: 'policy.yaml',
      models: [':sol'], modelAliases: { ':sol': 'openai-codex/gpt-5.6-sol' }, junoVersion: '2.1.3-test', attempts: 1, selectedStepIds: ['prepare'] } as const;
    const plan = await planWorkflowFromProject(deterministicInput);
    const generated = parse(Buffer.from(plan.compiled_workflows[0]!.workflow_bytes_base64, 'base64').toString('utf8')) as { steps: Array<{ command: string[] }> };
    expect(generated.steps[0]!.command).toEqual(['env', 'PYTHONPATH=.', 'python3', 'scripts/report.py', '--run-date', '{{ run_date }}']);

    await writeFile(path.join(root, 'scripts', 'report.py'), 'print("drift")\n');
    await expect(planWorkflowFromProject(deterministicInput)).rejects.toThrow(/tracked script drift/u);
    await writeFile(path.join(root, 'scripts', 'report.py'), 'print("ok")\n');
    await writeFile(path.join(root, 'policy.yaml'), JSON.stringify({ ...deterministicPolicy, deterministic_commands: [] }));
    await expect(planWorkflowFromProject(deterministicInput)).rejects.toThrow(/exact policy binding/u);
    await writeFile(path.join(root, 'policy.yaml'), JSON.stringify(deterministicPolicy));
    await writeFile(path.join(root, 'workflow.yaml'), deterministicWorkflow.replace('scripts/report.py', '-c'));
    execFileSync('git', ['add', 'workflow.yaml'], { cwd: root }); execFileSync('git', ['commit', '-m', 'bad argv'], { cwd: root, stdio: 'ignore' });
    await expect(planWorkflowFromProject(deterministicInput)).rejects.toThrow(/tracked script drift|executable, environment, interpreter/u);
  });

  it('rejects unsupported YAML constructs and source-byte drift before planning', async () => {
    expect(() => parseWorkflowBytes(Buffer.from('schema_version: 2\nsteps:\n  - &base { id: one, command: [echo, ok] }\n  - *base\n'))).toThrow(/aliases/u);
    const root = await fixture(); await writeFile(path.join(root, 'workflow.yaml'), `${workflowText}# dirty\n`);
    await expect(planWorkflowFromProject(input(root))).rejects.toThrow(/bound source commit/u);
  });

  it('plans read-only through the CLI and makes --task and --workflow mutually exclusive', async () => {
    const root = await fixture(); const output: string[] = [];
    await runCli(['plan', '--workflow', 'workflow.yaml', '--steps-file', 'policy.yaml', '--models', ':sol,zai/glm-5.2', '--steps', 'prepare,analyze', '--var', 'run_date=2026-08-12', '--dry-run'], { cwd: root, stdout: (text) => output.push(text) });
    expect(JSON.parse(output.join(''))).toMatchObject({ schema_version: 'juno_benchmark_workflow_plan.v2', attempts: 1, selected_step_ids: ['prepare', 'analyze'] });
    await expect(stat(path.join(root, '.juno_task', 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });

    const program = createProgram().configureOutput({ writeErr: () => undefined });
    program.commands.find((item) => item.name() === 'plan')!.exitOverride();
    await expect(program.parseAsync(['plan', '--task', 'T1', '--workflow', 'w.yaml', '--models', ':sol'], { from: 'user' }))
      .rejects.toMatchObject({ code: 'commander.conflictingOption' });
  });
});
