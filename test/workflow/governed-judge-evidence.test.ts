import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_LAUNCHER_PROTOCOL } from '../../src/auth/index.js';
import { canonicalHash, canonicalJson } from '../../src/contracts/canonical.js';
import { PersistentTypedResourceLocks } from '../../src/execution/resource-lock.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { doctorWorkflowExperiment } from '../../src/doctor/index.js';
import { buildBlindedJudgePacket, readWorkflowEvidenceReceipts, rejudgeRetainedWorkflowStep, verifyWorkflowEvidenceReceipt, type GovernedJudgeExecutionEnvelope, type GovernedWorkflowJudgeRunner } from '../../src/workflow/evidence.js';
import { planWorkflowFromProject, type WorkflowExecutionPlan, type WorkflowPolicy } from '../../src/workflow/plan.js';
import { executeWorkflowPlan, type TrustedWorkflowDispatcher, type WorkflowRuntimeInvocation, type WorkflowRuntimeTerminalResult } from '../../src/workflow/runtime.js';

const RUBRIC = 'Judge whether the retained response satisfies the exact task using only the bound evidence.';
const JUDGE_MODEL = 'openai-codex/gpt-5.6-sol';

async function fixture(options: { rubric?: boolean; requiredArtifact?: boolean; redactionFailure?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'governed-judge-'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  await writeFile(path.join(root, 'workflow.yaml'), 'schema_version: 2\nworkflow_id: governed\nsteps:\n  - id: analyze\n    command: [yy, pi, "Return the verified answer"]\n');
  const policy: WorkflowPolicy = { schema_version: 'juno_benchmark_workflow_policy.v1',
    judge: { judge_id: 'governed', judge_version: '2', model: JUDGE_MODEL, rubric_hash: 'sha256:1146107becfa5be434be9b813424c5c5c8450264ed37265916c6e38f6f60649f', ...(options.rubric === false ? {} : { rubric: RUBRIC }) },
    authorization: { authorization_id: 'fixture', production: false, spend: false }, recovery: { ambiguous_effect: 'manual', max_recovery_attempts: 1 },
    redaction: { secret_patterns: options.redactionFailure ? ['SECRET|\\[REDACTED\\]'] : ['SECRET'], retain_prompts: false },
    steps: [{ step_id: 'analyze', scoring_id: 'opaque-score', side_effect: 'none', resources: [], limits: { timeout_ms: 1000, max_usd: 0 }, authorization: 'none', recovery: 'retry_safe',
      redaction: { patterns: [], retain_prompt: false }, ...(options.requiredArtifact ? { required_artifacts: ['proof.json'] } : {}) }] };
  const policyPath = path.join(root, 'policy.yaml'); await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(path.join(root, '.juno_task', 'config.json'), JSON.stringify({ workflowModels: [JUDGE_MODEL] }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' }); execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root }); execFileSync('git', ['add', 'workflow.yaml'], { cwd: root }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const plan = await planWorkflowFromProject({ projectRoot: root, repositoryId: 'fixture', workflowPath: 'workflow.yaml', policyPath, models: [JUDGE_MODEL], modelAliases: {}, attempts: 1,
    junoVersion: '2.1.3-built', boundaryIdentity: { protocol: 'juno_benchmark_workflow_process_boundary.v1', sha256: `sha256:${'b'.repeat(64)}` } });
  return { root, policyPath, plan, registry: new ImmutableArtifactRegistry(path.join(root, 'registry')), locks: new PersistentTypedResourceLocks({ root: path.join(root, 'locks') }) };
}
function candidate(input: WorkflowRuntimeInvocation, artifacts: Readonly<Record<string, string>> = {}): WorkflowRuntimeTerminalResult {
  return { dispatch_id: input.dispatch_id, status: 'success', effect: 'completed', runner_run_id: 'candidate-run', observed_provider: input.provider, observed_model: input.model, observed_juno_version: input.juno_version,
    evidence: { outer_session_id: 'candidate-session', nested_session_ids: ['candidate-nested'], started_at: '2026-08-30T00:00:00.000Z', ended_at: '2026-08-30T00:00:01.000Z', runtime_ms: 1000,
      cost: { completeness: 'complete', usd: 0.2 }, candidate_outcome: { status: 'success' }, harness_validity: { status: 'valid', reason: null }, transcript: 'Verified answer.', artifacts } };
}
function dispatcher(artifacts: Readonly<Record<string, string>> = {}): TrustedWorkflowDispatcher { return { protocol: AUTH_LAUNCHER_PROTOCOL, providers: new Set(['openai-codex']), preflight: async () => undefined,
  dispatch: async (input) => candidate(input, artifacts), reconcile: async () => ({ state: 'ambiguous' }), resume: async (input) => candidate(input, artifacts) }; }
function envelope(input: Parameters<GovernedWorkflowJudgeRunner>[0], overrides: Partial<GovernedJudgeExecutionEnvelope> = {}): GovernedJudgeExecutionEnvelope {
  const base: GovernedJudgeExecutionEnvelope = { schema_version: 'juno_benchmark_governed_judge_envelope.v1', judge_dispatch_id: input.judge_dispatch_id,
    requested: { provider: 'openai-codex', model: 'gpt-5.6-sol', juno_version: input.requested_juno_version }, observed: { provider: 'openai-codex', model: 'gpt-5.6-sol', juno_version: input.requested_juno_version },
    session_id: `judge-${input.judge_dispatch_id.slice(-12)}`, started_at: '2026-08-30T00:00:02.000Z', ended_at: '2026-08-30T00:00:03.000Z', runtime_ms: 1000,
    cost: { completeness: 'partial', usd: 0.03 }, exit_status: { code: 0, signal: null }, dispatched: true, dispatch_proof: 'terminal', verdict: 'fail', justification: 'The answer omits the required proof.\nVERDICT: FAIL', terminal_class: 'judge_rejection' };
  return { ...base, ...overrides };
}
async function run(item: Awaited<ReturnType<typeof fixture>>, judge: GovernedWorkflowJudgeRunner, artifacts: Readonly<Record<string, string>> = {}) {
  await executeWorkflowPlan({ plan: item.plan, projectRoot: item.root, policyPath: item.policyPath, registry: item.registry, locks: item.locks, dispatcher: dispatcher(artifacts), judge,
    boundaryIdentity: item.plan.runtime_binding.boundary! });
  return (await readWorkflowEvidenceReceipts(item.registry, `workflow-${item.plan.plan_id.slice(7)}`))[0]!;
}

describe('governed judge evidence envelope', () => {
  it('retains one exact independent judge identity, packet, envelope, and redacted factual justification for a valid rejection', async () => {
    const item = await fixture({ requiredArtifact: true }); let packet = ''; const receipt = await run(item, async (input) => { packet = input.blinded_candidate; return envelope(input); }, { 'proof.json': '{"ok":true}' });
    expect(receipt.terminal_class).toBe('judge_rejection'); expect(receipt.judge_outcome).toMatchObject({ valid: true, verdict: 'fail', resolved: false, terminal_class: 'judge_rejection' });
    const retainedEnvelope = JSON.parse((await item.registry.read(receipt.judge_outcome.envelope_ref)).toString('utf8')) as GovernedJudgeExecutionEnvelope;
    expect(retainedEnvelope).toMatchObject({ observed: { provider: 'openai-codex', model: 'gpt-5.6-sol', juno_version: '2.1.3-built' }, session_id: expect.stringMatching(/^judge-/u), runtime_ms: 1000,
      cost: { completeness: 'partial', usd: 0.03 }, exit_status: { code: 0, signal: null } });
    const parsed = JSON.parse(packet) as { task: { content: string }; rubric: { content: string }; artifacts: unknown[] };
    expect(parsed.task.content).toContain('Return the verified answer'); expect(parsed.rubric.content).toBe(RUBRIC); expect(parsed.artifacts).toHaveLength(1);
    const justification = JSON.parse((await item.registry.read(receipt.judge_outcome.justification_ref)).toString('utf8')) as { text: string };
    expect(justification.text).toContain('required proof'); expect(receipt.judge_outcome.justification_hash).toBe(receipt.judge_outcome.justification_ref.sha256);
  });

  const failures: readonly [string, (input: Parameters<GovernedWorkflowJudgeRunner>[0]) => unknown, string][] = [
    ['provider non-dispatch', (input) => envelope(input, { dispatched: false, observed: { provider: null, model: null, juno_version: null }, session_id: null, exit_status: { code: null, signal: null }, verdict: null, terminal_class: 'judge_harness_failure' }), 'judge_harness_failure'],
    ['exit nonzero', (input) => envelope(input, { exit_status: { code: 7, signal: null }, session_id: null, verdict: null, terminal_class: 'judge_harness_failure' }), 'judge_harness_failure'],
    ['timeout', (input) => envelope(input, { exit_status: { code: null, signal: 'SIGTERM' }, session_id: null, verdict: null, terminal_class: 'judge_timeout' }), 'judge_timeout'],
    ['no strict verdict', (input) => envelope(input, { verdict: null, terminal_class: 'judge_invalid_evidence' }), 'judge_invalid_evidence'],
    ['malformed response', () => ({ resolved: false, evidence: 'legacy malformed response' }), 'judge_invalid_evidence'],
    ['missing session', (input) => envelope(input, { session_id: null }), 'judge_harness_failure'],
    ['identity mismatch', (input) => envelope(input, { observed: { provider: 'zai', model: 'glm-5.3', juno_version: input.requested_juno_version } }), 'judge_harness_failure'],
  ];
  for (const [name, result, expected] of failures) it(`fails closed for ${name} without turning unknown into rejection`, async () => {
    const item = await fixture(); const receipt = await run(item, async (input) => result(input) as GovernedJudgeExecutionEnvelope);
    expect(receipt.judge_outcome).toMatchObject({ valid: false, verdict: null, resolved: null, terminal_class: expected }); expect(receipt.terminal_class).toBe(expected);
    const report = await import('../../src/workflow/evidence.js').then(({ buildWorkflowExperimentReport }) => buildWorkflowExperimentReport(item.registry, item.plan));
    expect(report.comparison[0]!.by_model[JUDGE_MODEL]).toBe('unknown'); expect(report.winner).toBeNull();
  });

  it('fails closed before judge dispatch for missing rubric/task bytes and absent required artifacts', async () => {
    for (const item of [await fixture({ rubric: false }), await fixture({ requiredArtifact: true })]) {
      let calls = 0; const receipt = await run(item, async (input) => { calls += 1; return envelope(input); });
      expect(calls).toBe(0); expect(receipt.judge_outcome).toMatchObject({ valid: false, resolved: null, terminal_class: 'judge_invalid_evidence' });
    }
    const item = await fixture();
    const missingTask = { ...item.plan, normalized_workflow: { ...item.plan.normalized_workflow, steps: [] } } as WorkflowExecutionPlan;
    expect(() => buildBlindedJudgePacket(missingTask, 'analyze', 'opaque-score', canonicalHash('truth'), 'retained', {},
      { candidate_outcome: { status: 'success' }, harness_validity: { status: 'valid', reason: null } })).toThrow(/task requirement bytes are missing/u);
  });

  it('rejudges only invalid judge work from retained candidate truth with zero candidate redispatch', async () => {
    const item = await fixture(); let judgeCalls = 0;
    const receipt = await run(item, async (input) => { judgeCalls += 1; return envelope(input, { verdict: null, terminal_class: 'judge_invalid_evidence' }); });
    const judgement = await rejudgeRetainedWorkflowStep({ registry: item.registry, experimentId: `workflow-${item.plan.plan_id.slice(7)}`, receipt,
      trustedReceiptHash: receipt.receipt_hash, expectedPolicySemanticsHash: item.plan.policy_semantics_sha256 as `sha256:${string}`, judge: item.plan.policy.judge,
      runner: async (input) => { judgeCalls += 1; return envelope(input, { verdict: 'pass', terminal_class: 'judge_acceptance', justification: 'Verified.\nVERDICT: PASS' }); },
      locks: item.locks, plan: item.plan });
    expect(judgement).toMatchObject({ valid: true, resolved: true, generation: 2 }); expect(judgeCalls).toBe(2);
    const again = await rejudgeRetainedWorkflowStep({ registry: item.registry, experimentId: `workflow-${item.plan.plan_id.slice(7)}`, receipt,
      trustedReceiptHash: receipt.receipt_hash, expectedPolicySemanticsHash: item.plan.policy_semantics_sha256 as `sha256:${string}`, judge: item.plan.policy.judge,
      runner: async () => { throw new Error('valid judge work must not redispatch'); }, locks: item.locks, plan: item.plan });
    expect(again.judgement_id).toBe(judgement.judgement_id); expect(judgeCalls).toBe(2);
  });

  it('refuses rejudge after an ambiguous judge-boundary loss instead of risking duplicate paid work', async () => {
    const item = await fixture(); const receipt = await run(item, async () => { throw new Error('judge boundary process loss'); }); let calls = 0;
    await expect(rejudgeRetainedWorkflowStep({ registry: item.registry, experimentId: `workflow-${item.plan.plan_id.slice(7)}`, receipt,
      trustedReceiptHash: receipt.receipt_hash, expectedPolicySemanticsHash: item.plan.policy_semantics_sha256 as `sha256:${string}`, judge: item.plan.policy.judge,
      runner: async (input) => { calls += 1; return envelope(input); }, locks: item.locks, plan: item.plan })).rejects.toThrow(/ambiguous external effect/u);
    expect(calls).toBe(0);
  });

  it('retains redaction failure as judge-invalid and detects retained-object evidence tampering', async () => {
    const item = await fixture({ redactionFailure: true }); const receipt = await run(item, async (input) => envelope(input, { justification: 'SECRET\nVERDICT: FAIL' }));
    expect(receipt.judge_outcome).toMatchObject({ valid: false, resolved: null, terminal_class: 'judge_invalid_evidence' });
    const forgedJudgement = { ...receipt.judge_outcome, justification_hash: canonicalHash('forged') };
    const { judgement_id: _id, ...judgementCore } = forgedJudgement; const boundJudgement = { ...forgedJudgement, judgement_id: canonicalHash(judgementCore) };
    const { receipt_hash: _hash, ...receiptCore } = receipt; const forged = { ...receiptCore, judge_outcome: boundJudgement };
    await expect(verifyWorkflowEvidenceReceipt(item.registry, { ...forged, receipt_hash: canonicalHash(forged) })).rejects.toThrow(/retained-object binding/u);
  });

  it('Doctor reports the reproduced hash-only v1 judgement shape as judge-invalid without rewriting it', async () => {
    const item = await fixture(); const current = await run(item, async (input) => envelope(input));
    const oldJudgementCore = { schema_version: 'juno_benchmark_workflow_judgement.v1', candidate_truth_hash: current.candidate_truth_hash, scoring_id: current.scoring_id,
      judge: current.judge_outcome.judge, judge_policy_hash: canonicalHash(current.judge_outcome.judge), generation: 1, resolved: false, evidence_hash: canonicalHash('discarded') };
    const oldJudgement = { ...oldJudgementCore, judgement_id: canonicalHash(oldJudgementCore) };
    const { legacy: _legacy, receipt_hash: _receiptHash, ...currentCore } = current; const legacyCore = { ...currentCore, schema_version: 'juno_benchmark_workflow_evidence_receipt.v2', judge_outcome: oldJudgement, terminal_class: 'judge_failure' };
    const legacy = { ...legacyCore, receipt_hash: canonicalHash(legacyCore) }; const reference = await item.registry.put('workflow-evidence-receipt', `${canonicalJson(legacy)}\n`);
    const experimentId = `workflow-${'c'.repeat(64)}`; await item.registry.append(experimentId, reference); const result = await doctorWorkflowExperiment(item.registry, experimentId);
    expect(result).toMatchObject({ ok: false, evidenceReceipts: 1, judgeInvalid: 1 });
  });
});
