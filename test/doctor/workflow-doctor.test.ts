import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_LAUNCHER_PROTOCOL } from '../../src/auth/index.js';
import { PersistentTypedResourceLocks } from '../../src/execution/resource-lock.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { doctorWorkflowExperiment, isWorkflowExperimentId } from '../../src/doctor/index.js';
import { executeWorkflowPlan, type TrustedWorkflowDispatcher, type WorkflowRuntimeInvocation, type WorkflowRuntimeTerminalResult } from '../../src/workflow/runtime.js';
import { planWorkflowFromProject, type WorkflowExecutionPlan, type WorkflowPolicy } from '../../src/workflow/plan.js';

const workflow = `schema_version: 2
workflow_id: doctor-fixture
steps:
  - id: publish
    command: [yy, pi, "publish safely"]
`;

const policy: WorkflowPolicy = {
  schema_version: 'juno_benchmark_workflow_policy.v1',
  judge: { judge_id: 'later', judge_version: '1', model: ':sol', rubric_hash: 'sha256:9dbb9b78955fdf1dbacbc5a2004dce18a1d97e8c5f2f239e6bfe4a3e5dfc1b4d', rubric: 'binary rubric' },
  authorization: { authorization_id: 'legacy-metadata-only', production: false, spend: false },
  recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 },
  redaction: { secret_patterns: ['API_KEY'], retain_prompts: false },
  steps: [{ step_id: 'publish', scoring_id: 'publish-score', side_effect: 'none',
    resources: [], limits: { timeout_ms: 5000, max_usd: 0 }, authorization: 'none', recovery: 'manual',
    redaction: { patterns: ['API_KEY'], retain_prompt: false } }],
};

async function fixture(): Promise<{ root: string; plan: WorkflowExecutionPlan; policyPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-doctor-'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  const policyPath = path.join(root, 'policy.yaml');
  await writeFile(path.join(root, 'workflow.yaml'), workflow);
  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(path.join(root, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':sol'] }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'workflow.yaml'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const plan = await planWorkflowFromProject({ projectRoot: root, repositoryId: 'fixture', workflowPath: 'workflow.yaml', policyPath,
    models: [':sol'], modelAliases: { ':sol': 'openai-codex/gpt-5.6-sol' }, junoVersion: '2.1.3-test',
    boundaryIdentity: { protocol: 'juno_benchmark_workflow_process_boundary.v1', sha256: `sha256:${'b'.repeat(64)}` }, attempts: 1,
    selectedStepIds: ['publish'], variables: { date: '2026-08-12' } });
  return { root, plan, policyPath };
}

function terminal(input: WorkflowRuntimeInvocation, harness: 'valid' | 'invalid' = 'valid'): WorkflowRuntimeTerminalResult {
  return { dispatch_id: input.dispatch_id, status: 'failure', effect: 'completed', runner_run_id: `run-${input.step_id}`,
    observed_provider: input.provider, observed_model: input.model, observed_juno_version: input.juno_version, evidence: {
      outer_session_id: `outer-${input.dispatch_id.slice(-8)}`, nested_session_ids: [`nested-${input.dispatch_id.slice(-8)}`],
      started_at: '2026-08-12T09:00:00.000Z', ended_at: '2026-08-12T09:00:01.000Z', runtime_ms: 1000,
      cost: { completeness: 'unavailable', usd: null }, candidate_outcome: { status: 'failure' },
      harness_validity: harness === 'invalid'
        ? { status: 'invalid', reason: `workflow step ${input.step_id} produced no juno_execution_envelope.v1 terminal identity (exit 99)` }
        : { status: 'valid', reason: null },
      transcript: 'controller-resolver diagnostic', artifacts: {},
    } };
}

function dispatcher(overrides: Partial<TrustedWorkflowDispatcher> = {}): TrustedWorkflowDispatcher {
  return { protocol: AUTH_LAUNCHER_PROTOCOL, providers: new Set(['openai-codex', 'zai']), preflight: async () => undefined,
    dispatch: async (input) => terminal(input), reconcile: async () => ({ state: 'ambiguous' }),
    resume: async (input) => terminal(input), ...overrides };
}

function options(item: Awaited<ReturnType<typeof fixture>>, registryName = 'registry') {
  return { plan: item.plan, projectRoot: item.root, policyPath: item.policyPath,
    registry: new ImmutableArtifactRegistry(path.join(item.root, registryName)),
    locks: new PersistentTypedResourceLocks({ root: path.join(item.root, `${registryName}-locks`) }),
    dispatcher: dispatcher(), judge: async (input: { judge_dispatch_id: `sha256:${string}`; requested_juno_version: string }) => ({
      schema_version: 'juno_benchmark_governed_judge_envelope.v1' as const, judge_dispatch_id: input.judge_dispatch_id,
      requested: { provider: '', model: ':sol', juno_version: input.requested_juno_version }, observed: { provider: '', model: ':sol', juno_version: input.requested_juno_version },
      session_id: `judge-${input.judge_dispatch_id.slice(-8)}`, started_at: '2026-08-12T09:00:00.000Z', ended_at: '2026-08-12T09:00:01.000Z', runtime_ms: 1000,
      cost: { completeness: 'complete' as const, usd: 0 }, exit_status: { code: 0, signal: null }, dispatched: true, dispatch_proof: 'terminal', verdict: 'pass' as const,
      justification: 'Factual pass.\nVERDICT: PASS', terminal_class: 'judge_acceptance' as const,
    }), boundaryIdentity: item.plan.runtime_binding.boundary! };
}

describe('workflow experiment doctor', () => {
  it('classifies workflow registry identities and rejects Kanban-shaped ids', () => {
    expect(isWorkflowExperimentId(`workflow-${'a'.repeat(64)}`)).toBe(true);
    expect(isWorkflowExperimentId('workflow-not-hex')).toBe(false);
    expect(isWorkflowExperimentId('D0tTNr')).toBe(false);
    expect(isWorkflowExperimentId(`sha256:${'a'.repeat(64)}`)).toBe(false);
  });

  it('verifies retained workflow evidence without any Ledger read, including harness-failure terminals', async () => {
    const item = await fixture();
    const run = await executeWorkflowPlan(options(item));
    expect(run.terminals).toHaveLength(1);
    // A harness failure is retained terminal truth, not a doctor defect.
    const failingItem = await fixture();
    const failingRun = await executeWorkflowPlan({ ...options(failingItem),
      dispatcher: dispatcher({ dispatch: async (input) => terminal(input, 'invalid') }) });
    expect(failingRun.terminals[0]!.result.status).toBe('failure');
    const healthy = await doctorWorkflowExperiment(new ImmutableArtifactRegistry(path.join(item.root, 'registry')),
      `workflow-${item.plan.plan_id.slice(7)}`);
    expect(healthy).toMatchObject({ ok: true, dispatchIntents: 1, terminals: 1, evidenceReceipts: 1, ambiguousDispatches: 0 });
    const failingDoctor = await doctorWorkflowExperiment(new ImmutableArtifactRegistry(path.join(failingItem.root, 'registry')),
      `workflow-${failingItem.plan.plan_id.slice(7)}`);
    expect(failingDoctor).toMatchObject({ ok: true, dispatchIntents: 1, terminals: 1, evidenceReceipts: 1,
      harnessFailureTerminals: 1, ambiguousDispatches: 0 });
    await expect(doctorWorkflowExperiment(new ImmutableArtifactRegistry(path.join(item.root, 'registry')), 'D0tTNr'))
      .rejects.toThrow(/experiment identity is invalid/u);
  });

  it('reports dispatch intents without terminals as ambiguous recovery work', async () => {
    const item = await fixture();
    await expect(executeWorkflowPlan({ ...options(item), dispatcher: dispatcher({ dispatch: async () => { throw new Error('process loss'); } }) }))
      .rejects.toThrow(/process loss/u);
    const result = await doctorWorkflowExperiment(new ImmutableArtifactRegistry(path.join(item.root, 'registry')),
      `workflow-${item.plan.plan_id.slice(7)}`);
    expect(result).toMatchObject({ ok: false, dispatchIntents: 1, terminals: 0, ambiguousDispatches: 1 });
  });
});
