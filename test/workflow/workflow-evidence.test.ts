import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_LAUNCHER_PROTOCOL } from '../../src/auth/index.js';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { PersistentTypedResourceLocks } from '../../src/execution/resource-lock.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { buildWorkflowExperimentReport, readWorkflowEvidenceReceipts, rejudgeRetainedWorkflowStep, verifyWorkflowEvidenceReceiptValue, type WorkflowEvidenceReceipt } from '../../src/workflow/evidence.js';
import { planWorkflowFromProject, type WorkflowPolicy } from '../../src/workflow/plan.js';
import { executeWorkflowPlan, type TrustedWorkflowDispatcher, type WorkflowRuntimeInvocation, type WorkflowRuntimeTerminalResult } from '../../src/workflow/runtime.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-evidence-'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  const workflow = `schema_version: 2
workflow_id: evidence
steps:
  - id: first
    command: [yy, pi, first]
  - id: second
    command: [yy, pi, second]
`;
  const policy: WorkflowPolicy = { schema_version: 'juno_benchmark_workflow_policy.v1',
    judge: { judge_id: 'binary', judge_version: '1', model: ':sol', rubric_hash: `sha256:${'a'.repeat(64)}` },
    authorization: { authorization_id: 'legacy-metadata', production: false, spend: false },
    recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 }, redaction: { secret_patterns: [], retain_prompts: false },
    steps: ['first', 'second'].map((id) => ({ step_id: id, scoring_id: `${id}-score`, side_effect: 'none' as const,
      resources: [], limits: { timeout_ms: 5000, max_usd: 0 }, authorization: 'none' as const, recovery: 'retry_safe' as const,
      redaction: { patterns: [], retain_prompt: false } })) };
  const policyPath = path.join(root, 'policy.yaml');
  await writeFile(path.join(root, 'workflow.yaml'), workflow); await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(path.join(root, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [':sol'] }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'workflow.yaml'], { cwd: root }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const plan = await planWorkflowFromProject({ projectRoot: root, repositoryId: 'fixture', workflowPath: 'workflow.yaml', policyPath,
    models: [':sol'], modelAliases: { ':sol': 'openai-codex/gpt-5.6-sol' }, attempts: 1, selectedStepIds: ['first', 'second'] });
  return { root, plan, policyPath };
}
function terminal(input: WorkflowRuntimeInvocation, cost: WorkflowRuntimeTerminalResult['evidence']['cost']): WorkflowRuntimeTerminalResult {
  return { dispatch_id: input.dispatch_id, status: 'success', effect: 'completed', runner_run_id: `run-${input.step_id}`,
    observed_provider: input.provider, observed_model: input.model, evidence: { outer_session_id: 'outer', nested_session_ids: ['nested'],
      started_at: '2026-08-12T09:00:00.000Z', ended_at: '2026-08-12T09:00:01.000Z', runtime_ms: 1000, cost,
      candidate_outcome: { status: 'success' }, harness_validity: { status: 'valid', reason: null }, transcript: input.step_id, artifacts: {} } };
}

describe('workflow evidence and observational cost', () => {
  it('retains unavailable and partial cost without invalidating results and reports observed totals', async () => {
    const item = await fixture(); const registry = new ImmutableArtifactRegistry(path.join(item.root, 'registry'));
    const locks = new PersistentTypedResourceLocks({ root: path.join(item.root, 'locks') }); let index = 0;
    const costs: WorkflowRuntimeTerminalResult['evidence']['cost'][] = [
      { completeness: 'unavailable', usd: null }, { completeness: 'partial', usd: 0.25 },
    ];
    const dispatcher: TrustedWorkflowDispatcher = { protocol: AUTH_LAUNCHER_PROTOCOL, providers: new Set(['openai-codex']),
      preflight: async () => undefined, dispatch: async (input) => terminal(input, costs[index++]!),
      reconcile: async () => ({ state: 'ambiguous' }), resume: async (input) => terminal(input, { completeness: 'unavailable', usd: null }) };
    await executeWorkflowPlan({ plan: item.plan, projectRoot: item.root, policyPath: item.policyPath, registry, locks, dispatcher,
      judge: async () => ({ resolved: true, evidence: 'pass' }) });
    const receipts = await readWorkflowEvidenceReceipts(registry, `workflow-${item.plan.plan_id.slice(7)}`);
    expect(receipts.map((receipt) => receipt.cost)).toEqual(costs);
    expect(receipts.every((receipt) => receipt.harness_validity.status === 'valid' && receipt.terminal_class === 'resolved')).toBe(true);
    const report = await buildWorkflowExperimentReport(registry, item.plan);
    expect(report.totals).toMatchObject({ resolved: 2, harness_invalid: 0, complete_cost_usd: 0, observed_cost_usd: 0.25, incomplete_cost_receipts: 2 });
  });

  it('rejudges retained truth without spend authorization or reservations', async () => {
    const item = await fixture(); const registry = new ImmutableArtifactRegistry(path.join(item.root, 'registry'));
    const locks = new PersistentTypedResourceLocks({ root: path.join(item.root, 'locks') });
    const dispatcher: TrustedWorkflowDispatcher = { protocol: AUTH_LAUNCHER_PROTOCOL, providers: new Set(['openai-codex']), preflight: async () => undefined,
      dispatch: async (input) => terminal(input, { completeness: 'unavailable', usd: null }), reconcile: async () => ({ state: 'ambiguous' }),
      resume: async (input) => terminal(input, { completeness: 'unavailable', usd: null }) };
    await executeWorkflowPlan({ plan: item.plan, projectRoot: item.root, policyPath: item.policyPath, registry, locks, dispatcher,
      judge: async () => ({ resolved: true, evidence: 'initial' }) });
    const experimentId = `workflow-${item.plan.plan_id.slice(7)}`;
    const receipt = (await readWorkflowEvidenceReceipts(registry, experimentId))[0]!;
    const judgement = await rejudgeRetainedWorkflowStep({ registry, experimentId, receipt, trustedReceiptHash: receipt.receipt_hash,
      expectedPolicySemanticsHash: item.plan.policy_semantics_sha256 as `sha256:${string}`, judge: item.plan.policy.judge,
      runner: async () => ({ resolved: true, evidence: 'rejudged' }), locks });
    expect(judgement.generation).toBe(2); expect(judgement.resolved).toBe(true);
    const roles = (await registry.verifyExperiment(experimentId)).map((entry) => entry.role);
    expect(roles).toContain('workflow-rejudge-intent'); expect(roles).toContain('workflow-rejudge-receipt');
  });

  it('keeps restart recovery independent from durable resume counts', async () => {
    const item = await fixture(); const registry = new ImmutableArtifactRegistry(path.join(item.root, 'registry'));
    const locks = new PersistentTypedResourceLocks({ root: path.join(item.root, 'locks') });
    const lost = { protocol: AUTH_LAUNCHER_PROTOCOL, providers: new Set(['openai-codex']), preflight: async () => undefined,
      dispatch: async (): Promise<never> => { throw new Error('process loss'); }, reconcile: async () => ({ state: 'proven_not_dispatched' as const }),
      resume: async (input) => terminal(input, { completeness: 'unavailable', usd: null }) };
    await expect(executeWorkflowPlan({ plan: item.plan, projectRoot: item.root, policyPath: item.policyPath, registry, locks, dispatcher: lost,
      judge: async () => ({ resolved: true, evidence: 'pass' }) })).rejects.toThrow(/process loss/u);
    await executeWorkflowPlan({ plan: item.plan, projectRoot: item.root, policyPath: item.policyPath, registry, locks,
      dispatcher: { ...lost, dispatch: async (input) => terminal(input, { completeness: 'unavailable', usd: null }) },
      judge: async () => ({ resolved: true, evidence: 'pass' }) });
    const experimentId = `workflow-${item.plan.plan_id.slice(7)}`;
    const receipt = (await readWorkflowEvidenceReceipts(registry, experimentId))[0]!;
    expect(receipt.dispatch_recovery).toMatchObject({ recovered: true, recovery_count: 1 });
    const { receipt_hash: priorHash, ...core } = receipt;
    expect(priorHash).toBe(canonicalHash(core));
    const rehash = (dispatchRecovery: WorkflowEvidenceReceipt['dispatch_recovery']): WorkflowEvidenceReceipt =>
      ({ ...core, dispatch_recovery: dispatchRecovery, receipt_hash: canonicalHash({ ...core, dispatch_recovery: dispatchRecovery }) });
    expect(() => verifyWorkflowEvidenceReceiptValue(rehash({ ...core.dispatch_recovery, recovered: false })))
      .toThrow(/workflow recovery evidence is invalid/u);
    expect(() => verifyWorkflowEvidenceReceiptValue(rehash({ ...core.dispatch_recovery, recovered: true, recovery_count: 0 }))).not.toThrow();
    expect(() => verifyWorkflowEvidenceReceiptValue(rehash({ ...core.dispatch_recovery, recovered: 'true' as unknown as boolean, recovery_count: 0 })))
      .toThrow(/workflow recovery evidence is invalid/u);
  });
});
