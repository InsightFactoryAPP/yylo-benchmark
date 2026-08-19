import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_LAUNCHER_PROTOCOL } from '../../src/auth/index.js';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { PersistentTypedResourceLocks } from '../../src/execution/resource-lock.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { readWorkflowEvidenceReceipts } from '../../src/workflow/evidence.js';
import { planWorkflowFromProject, type WorkflowExecutionPlan, type WorkflowPolicy } from '../../src/workflow/plan.js';
import { createReviewedWorkflowBoundary, executeWorkflowPlan, type TrustedWorkflowDispatcher, type WorkflowRuntimeInvocation, type WorkflowRuntimeTerminalResult } from '../../src/workflow/runtime.js';

const modelWorkflow = `schema_version: 2
workflow_id: runtime
steps:
  - id: publish
    command: [yy, pi, "publish safely"]
`;
function policy(recovery: 'manual' | 'retry_safe' = 'manual', steps = ['publish']): WorkflowPolicy {
  return {
    schema_version: 'juno_benchmark_workflow_policy.v1',
    judge: { judge_id: 'later', judge_version: '1', model: ':sol', rubric_hash: `sha256:${'a'.repeat(64)}` },
    authorization: { authorization_id: 'legacy-metadata-only', production: false, spend: false },
    recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 },
    redaction: { secret_patterns: ['API_KEY'], retain_prompts: false },
    steps: steps.map((stepId) => ({ step_id: stepId, scoring_id: `${stepId}-score`, side_effect: 'none' as const,
      resources: [], limits: { timeout_ms: 5000, max_usd: 0 }, authorization: 'none' as const, recovery,
      redaction: { patterns: ['API_KEY'], retain_prompt: false } })),
  };
}
async function fixture(definition: { workflow?: string; policy?: WorkflowPolicy; selected?: string[] } = {}): Promise<{ root: string; plan: WorkflowExecutionPlan; policyPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  const policyPath = path.join(root, 'policy.yaml');
  await writeFile(path.join(root, 'workflow.yaml'), definition.workflow ?? modelWorkflow);
  await writeFile(policyPath, JSON.stringify(definition.policy ?? policy()));
  await writeFile(path.join(root, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':sol', 'zai/glm-5.2'] }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'workflow.yaml'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const plan = await planWorkflowFromProject({ projectRoot: root, repositoryId: 'fixture', workflowPath: 'workflow.yaml', policyPath,
    models: [':sol', 'zai/glm-5.2'], modelAliases: { ':sol': 'openai-codex/gpt-5.6-sol' }, attempts: 1,
    selectedStepIds: definition.selected ?? ['publish'], variables: { date: '2026-08-12' } });
  return { root, plan, policyPath };
}
function terminal(input: WorkflowRuntimeInvocation, cost: WorkflowRuntimeTerminalResult['evidence']['cost'] = { completeness: 'unavailable', usd: null }): WorkflowRuntimeTerminalResult {
  return { dispatch_id: input.dispatch_id, status: 'success', effect: 'completed', runner_run_id: `run-${input.step_id}`,
    observed_provider: input.provider, observed_model: input.model, evidence: {
      outer_session_id: `outer-${input.dispatch_id.slice(-8)}`, nested_session_ids: [`nested-${input.dispatch_id.slice(-8)}`],
      started_at: '2026-08-12T09:00:00.000Z', ended_at: '2026-08-12T09:00:01.000Z', runtime_ms: 1000,
      cost, candidate_outcome: { status: 'success' }, harness_validity: { status: 'valid', reason: null },
      transcript: 'candidate output', artifacts: { output: 'retained' },
    } };
}
const judge = async () => ({ resolved: true, evidence: 'governed pass' });
function dispatcher(overrides: Partial<TrustedWorkflowDispatcher> = {}): TrustedWorkflowDispatcher {
  return { protocol: AUTH_LAUNCHER_PROTOCOL, providers: new Set(['openai-codex', 'zai']), preflight: async () => undefined,
    dispatch: async (input) => terminal(input), reconcile: async () => ({ state: 'ambiguous' }),
    resume: async (input) => terminal(input), ...overrides };
}
function options(item: Awaited<ReturnType<typeof fixture>>, registryName = 'registry') {
  return { plan: item.plan, projectRoot: item.root, policyPath: item.policyPath,
    registry: new ImmutableArtifactRegistry(path.join(item.root, registryName)),
    locks: new PersistentTypedResourceLocks({ root: path.join(item.root, `${registryName}-locks`) }),
    dispatcher: dispatcher(), judge };
}

describe('immutable workflow runtime', () => {
  it('rejects scalar, shell, interpreter, and wrapper commands before invoking the reviewed module', async () => {
    const item = await fixture(); const marker = path.join(item.root, 'provider-called'); const module = path.join(item.root, 'boundary.mjs');
    const source = `import { readFileSync, writeFileSync } from 'node:fs';
const operation = process.argv[2]; readFileSync(3, 'utf8');
if (operation !== 'probe') writeFileSync(${JSON.stringify(marker)}, operation);
process.stdout.write(JSON.stringify(operation === 'probe' ? { schema_version: 'juno_benchmark_workflow_process_boundary.v1', providers: ['openai-codex'] } : operation === 'preflight' ? { ok: true } : { resolved: true, evidence: 'pass' }));
`;
    await writeFile(module, source);
    const reviewed = await createReviewedWorkflowBoundary({ module: await realpath(module), sha256: createHash('sha256').update(source).digest('hex') });
    const execution = item.plan.execution_order[0]!; const compiled = item.plan.compiled_workflows[0]!;
    const base = { dispatch_id: `sha256:${'1'.repeat(64)}` as const, plan_id: item.plan.plan_id, model: execution.model,
      provider: compiled.provider, attempt: execution.attempt, step_id: execution.step_id, variables: item.plan.variables, timeout_ms: 5000 };
    for (const command of ['"bash -c hidden"', '[bash, -c, "$AGENT exec"]', '[env, bash, -c, hidden]', '[python3, -c, hidden]', '[node, -e, hidden]']) {
      const raw = Buffer.from(`schema_version: 2\nworkflow_id: rejected\nsteps:\n  - id: publish\n    command: ${command}\n`);
      const core = { ...base, workflow_sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}` as const, workflow_bytes_base64: raw.toString('base64') };
      await expect(reviewed.dispatcher.dispatch({ ...core, invocation_hash: canonicalHash(core) })).rejects.toThrow(/argument array|approved direct ordinary/u);
    }
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes canonical model and minimal ordinary argv without authorization and accepts unavailable cost', async () => {
    const workflow = `schema_version: 2
workflow_id: mixed
steps:
  - id: prepare
    command: [printf, ready]
  - id: publish
    command: [yy, pi, "publish safely"]
`;
    const item = await fixture({ workflow, policy: policy('manual', ['prepare', 'publish']), selected: ['prepare', 'publish'] });
    const preflights: string[] = [];
    const result = await executeWorkflowPlan({ ...options(item), dispatcher: dispatcher({ preflight: async (input) => { preflights.push(input.step_id); } }) });
    expect('terminals' in result && result.terminals).toHaveLength(4);
    expect(preflights).toEqual(['prepare', 'publish', 'prepare', 'publish']);
    const receipts = await readWorkflowEvidenceReceipts(options(item).registry, `workflow-${item.plan.plan_id.slice(7)}`);
    expect(receipts).toHaveLength(4);
    expect(receipts.every((receipt) => receipt.cost.completeness === 'unavailable' && receipt.harness_validity.status === 'valid')).toBe(true);
  });

  it('retains complete and partial cost as evidence without enforcing a ceiling', async () => {
    const item = await fixture(); let calls = 0;
    const costs = [{ completeness: 'complete' as const, usd: 999 }, { completeness: 'partial' as const, usd: 0.25 }];
    const result = await executeWorkflowPlan({ ...options(item), dispatcher: dispatcher({ dispatch: async (input) => terminal(input, costs[calls++]!) }) });
    expect('terminals' in result && result.terminals).toHaveLength(2);
    const receipts = await readWorkflowEvidenceReceipts(options(item).registry, `workflow-${item.plan.plan_id.slice(7)}`);
    expect(receipts.map((receipt) => receipt.cost)).toEqual(costs);
    expect(receipts.every((receipt) => receipt.harness_validity.status === 'valid')).toBe(true);
  });

  it('keeps durable intent recovery and refuses ambiguous redispatch', async () => {
    const item = await fixture({ policy: policy('retry_safe') }); const shared = options(item); let dispatches = 0;
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ dispatch: async () => { dispatches += 1; throw new Error('process loss'); } }) })).rejects.toThrow(/process loss/u);
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher() })).rejects.toThrow(/ambiguous external effect/u);
    let resumes = 0;
    const recovered = await executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ reconcile: async () => ({ state: 'proven_not_dispatched' }),
      resume: async (input) => { resumes += 1; return terminal(input); } }) });
    expect(dispatches).toBe(1); expect(resumes).toBe(1); expect(recovered).toMatchObject({ recovered: true });
  });

  it('persists, reports, and enforces recovery attempts across process restarts', async () => {
    const basePolicy = policy('retry_safe'); const recoveryPolicy = { ...basePolicy, recovery: { ...basePolicy.recovery, max_recovery_attempts: 2 } };
    const item = await fixture({ policy: recoveryPolicy }); const shared = options(item); let resumes = 0;
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ dispatch: async () => { throw new Error('process loss'); } }) }))
      .rejects.toThrow(/process loss/u);
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ reconcile: async () => ({ state: 'proven_not_dispatched' }),
      resume: async () => { resumes += 1; throw new Error('resume loss'); } }) })).rejects.toThrow(/resume loss/u);
    const recovered = await executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ reconcile: async () => ({ state: 'proven_not_dispatched' }),
      resume: async (input) => { resumes += 1; return terminal(input); } }) });
    expect(recovered).toMatchObject({ recovered: true }); expect(resumes).toBe(2);
    const receipts = await readWorkflowEvidenceReceipts(shared.registry, `workflow-${item.plan.plan_id.slice(7)}`);
    expect(receipts[0]!.dispatch_recovery).toMatchObject({ recovered: true, recovery_count: 2 });
  });

  it('rejects recovery exhaustion before a new recovery intent or resume', async () => {
    const item = await fixture({ policy: policy('retry_safe') }); const shared = options(item); let resumes = 0;
    const experimentId = `workflow-${item.plan.plan_id.slice(7)}`;
    const recoveryIntents = async () => (await shared.registry.verifyExperiment(experimentId))
      .filter((entry) => entry.role === 'workflow-recovery-intent').length;
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ dispatch: async () => { throw new Error('process loss'); } }) }))
      .rejects.toThrow(/process loss/u);
    await expect(await recoveryIntents()).toBe(0);
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ reconcile: async () => ({ state: 'proven_not_dispatched' }),
      resume: async () => { resumes += 1; throw new Error('resume loss'); } }) })).rejects.toThrow(/resume loss/u);
    expect(resumes).toBe(1); expect(await recoveryIntents()).toBe(1);
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ reconcile: async () => ({ state: 'proven_not_dispatched' }),
      resume: async (input) => { resumes += 1; return terminal(input); } }) }))
      .rejects.toThrow(/exhausted recovery attempts/u);
    expect(resumes).toBe(1); expect(await recoveryIntents()).toBe(1);
  });

  it('marks terminal reconciliation recovered without consuming resume attempts', async () => {
    const item = await fixture({ policy: policy('retry_safe') }); const shared = options(item); let reconciles = 0; let resumes = 0;
    await expect(executeWorkflowPlan({ ...shared, dispatcher: dispatcher({ dispatch: async () => { throw new Error('process loss'); } }) }))
      .rejects.toThrow(/process loss/u);
    const outcome = await executeWorkflowPlan({ ...shared, dispatcher: dispatcher({
      reconcile: async (input) => { reconciles += 1; return { state: 'terminal' as const, result: terminal(input) }; },
      resume: async (input) => { resumes += 1; return terminal(input); } }) });
    expect(reconciles).toBe(1); expect(resumes).toBe(0); expect(outcome).toMatchObject({ recovered: true });
    const receipts = await readWorkflowEvidenceReceipts(shared.registry, `workflow-${item.plan.plan_id.slice(7)}`);
    expect(receipts[0]!.dispatch_recovery).toMatchObject({ recovered: true, recovery_count: 0 });
    expect(receipts[1]!.dispatch_recovery).toMatchObject({ recovered: false, recovery_count: 0 });
  });

  it('keeps dry-run read-only and reports best-effort cost tracking', async () => {
    const item = await fixture(); const registryRoot = path.join(item.root, 'dry-registry');
    const result = await executeWorkflowPlan({ plan: item.plan, projectRoot: item.root, policyPath: item.policyPath,
      registry: new ImmutableArtifactRegistry(registryRoot), locks: new PersistentTypedResourceLocks({ root: path.join(item.root, 'locks') }), dryRun: true });
    expect(result).toMatchObject({ dispatch_count: 0, cost_tracking: { mode: 'best_effort', unavailable_is_valid: true } });
    await expect(access(registryRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects workflow and policy drift before external effects', async () => {
    const item = await fixture(); let calls = 0; const base = { ...options(item), dispatcher: dispatcher({ preflight: async () => { calls += 1; } }) };
    await writeFile(path.join(item.root, 'policy.yaml'), `${await readFile(item.policyPath, 'utf8')}\n`);
    await expect(executeWorkflowPlan(base)).rejects.toThrow(/policy drift/u);
    expect(calls).toBe(0);
  });
});
