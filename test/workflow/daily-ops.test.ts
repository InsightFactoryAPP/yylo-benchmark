import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalHash, sha256Hex } from '../../src/contracts/canonical.js';
import {
  createDailyOpsCheckpoint, createStrictSequentialLock, planDailyOps, rejudgeDailyOps, runSyntheticDailyOps,
  type DailyOpsWorkflowDefinition, type WorkflowCandidateResult,
} from '../../src/workflow/index.js';

const digest = (value: string): `sha256:${string}` => canonicalHash(value);
const definitionBytes = readFileSync('workflows/daily_product_ops.yaml');
const definitionDigest = `sha256:${sha256Hex(definitionBytes)}` as const;
const resources = ['PROD_IF_BACKEND', 'PROD_INSIGHTAGENT_BACKEND', 'DATA_2026_PROVIDER'] as const;
const workflow: DailyOpsWorkflowDefinition = {
  schema_version: 'juno_benchmark_daily_ops_workflow.v1', workflow_id: 'daily-product-ops', workflow_revision: '2026-08-12.v1',
  definition_path: 'juno-benchmark/workflows/daily_product_ops.yaml', definition_hash: definitionDigest,
  steps: Array.from({ length: 13 }, (_, index) => ({
    step_id: `daily-ops-${String(index + 1).padStart(2, '0')}`,
    scoring_id: `daily-ops-2026-08-12-${String(index + 1).padStart(2, '0')}`,
    prompt: `Perform synthetic Daily Ops step ${index + 1}`,
    resources: [resources[index % resources.length]!],
  })),
};
const judge = { judge_id: 'frontier-governed', judge_version: '2026-08-12.1', prompt_hash: digest('judge prompt'), rubric_hash: digest('binary rubric') };
const estimates = [
  { model: 'openai-codex/gpt-5.6-sol', estimated_candidate_usd: 54, estimated_judge_usd: 2.6, estimated_runtime_ms: 4 * 60 * 60_000 },
  { model: 'openai-codex/gpt-5.6-terra', estimated_candidate_usd: 15, estimated_judge_usd: 2.6, estimated_runtime_ms: 3 * 60 * 60_000 },
  { model: 'openai-codex/gpt-5.6-luna', estimated_candidate_usd: 1.5, estimated_judge_usd: 2.6, estimated_runtime_ms: 2 * 60 * 60_000 },
  { model: 'zai/glm-5.2', estimated_candidate_usd: 8, estimated_judge_usd: 2.6, estimated_runtime_ms: 3 * 60 * 60_000 },
] as const;

function result(step: string, status: WorkflowCandidateResult['status'], secret: string): WorkflowCandidateResult {
  return { status, terminal_class: status === 'success' ? 'candidate_success' : status === 'failure' ? 'step_failure' : 'harness_invalid', outer_session_id: `outer-${step}`, nested_session_id: `nested-${step}`, started_at: '2026-08-12T09:00:00.000Z',
    ended_at: '2026-08-12T09:00:01.000Z', runtime_ms: 1000, cost: { completeness: 'complete', usd: 0.01 },
    transcript: `synthetic output ${secret}`, artifacts: { raw: secret, encoded: `${Buffer.from(secret).toString('hex')} ${Buffer.from(secret).toString('base64')} ${encodeURIComponent(secret)}` } };
}

describe('Daily Ops workflow contract', () => {
  it('binds plan construction to the exact tracked workflow bytes', () => {
    expect(() => planDailyOps({ workflow, definitionBytes: Buffer.concat([definitionBytes, Buffer.from('\n# altered')]), runDate: '2026-08-12', variables: {}, models: [estimates[0]], judge, authorization: 'synthetic_no_production' })).toThrow('tracked workflow definition hash mismatch');
    expect(() => planDailyOps({ workflow: { ...workflow, definition_hash: digest('mismatched source') }, definitionBytes, runDate: '2026-08-12', variables: {}, models: [estimates[0]], judge, authorization: 'synthetic_no_production' })).toThrow('tracked workflow definition hash mismatch');
    expect(planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: {}, models: [estimates[0]], judge, authorization: 'synthetic_no_production' }).workflow.definition_hash).toBe(definitionDigest);
  });

  it('produces 13 sequential, redacted, session/cost/judge receipts and recovers a stall once', async () => {
    const secret = 'sk_test_SYNTHETIC_123456789';
    const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: { mode: 'synthetic', credential_marker: secret }, models: [estimates[1]], judge, authorization: 'synthetic_no_production' });
    const dispatches: string[] = []; const recoveries: string[] = []; const judged: string[] = [];
    const receipts = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-terra', checkpoint: createDailyOpsCheckpoint(), lock: createStrictSequentialLock(), trustedSecrets: [secret],
      runner: {
        capability: 'synthetic_no_production' as const,
        dispatch: async (input) => { dispatches.push(input.dispatch_id); return result(input.step.step_id, input.step.step_id.endsWith('07') ? 'stalled' : 'success', secret); },
        recover: async (input) => { recoveries.push(input.dispatch_id); return result(input.step.step_id, 'success', secret); },
      },
      judge: async (input) => { judged.push(input.scoring_id); expect(input.anonymous_candidate).not.toContain(secret); return { resolved: true, evidence: `pass:${input.scoring_id}` }; },
    });

    expect(receipts).toHaveLength(13); expect(dispatches).toHaveLength(13); expect(new Set(dispatches).size).toBe(13); expect(recoveries).toHaveLength(1); expect(judged).toEqual(plan.scoring_ids);
    expect(receipts.map((item) => item.step_id)).toEqual(plan.selected_step_ids);
    expect(receipts.every((item) => item.outer_session_id.startsWith('outer-') && item.nested_session_id.startsWith('nested-'))).toBe(true);
    expect(receipts.every((item) => item.cost.completeness === 'complete' && item.runtime_ms === 1000)).toBe(true);
    expect(receipts[6]!.recovery).toEqual({ state: 'recovered', dispatch_count: 1, recovery_count: 1 });
    expect(receipts.every((item) => item.redaction.clean && item.redaction.scanned_surfaces.join(',') === 'plan,transcript,artifacts')).toBe(true);
    expect(receipts.every((item) => item.redaction.replacements >= 5)).toBe(true);
    const events = receipts.flatMap((item) => item.lock_events);
    expect(events.map((item) => item.sequence)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]!.action).toBe('acquire'); expect(events[index + 1]!.action).toBe('release');
      expect(events[index]!.dispatch_id).toBe(events[index + 1]!.dispatch_id);
    }
  });

  it('resumes a durable stalled step without duplicate dispatch and never reruns terminal steps', async () => {
    const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: {}, selectedStepIds: [workflow.steps[0]!.step_id], models: [estimates[0]], judge, authorization: 'synthetic_no_production' });
    const checkpoint = createDailyOpsCheckpoint(); const dispatchId = canonicalHash({ plan_id: plan.plan_id, model: 'openai-codex/gpt-5.6-sol', step_id: workflow.steps[0]!.step_id });
    checkpoint.dispatched.add(dispatchId); checkpoint.stalled.set(dispatchId, result(workflow.steps[0]!.step_id, 'stalled', 'none'));
    let dispatchCount = 0; let recoveryCount = 0;
    const options = { plan, model: 'openai-codex/gpt-5.6-sol', checkpoint, lock: createStrictSequentialLock(),
      runner: { capability: 'synthetic_no_production' as const, dispatch: async () => { dispatchCount += 1; throw new Error('duplicate'); }, recover: async () => { recoveryCount += 1; return result(workflow.steps[0]!.step_id, 'success', 'none'); } },
      judge: async () => ({ resolved: true, evidence: 'recovered' }),
    };
    const first = await runSyntheticDailyOps(options); const second = await runSyntheticDailyOps(options);
    expect(dispatchCount).toBe(0); expect(recoveryCount).toBe(1); expect(second[0]).toEqual(first[0]);
  });

  it('rejudges retained candidate truth without exposing a candidate dispatch API', async () => {
    const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: {}, selectedStepIds: [workflow.steps[0]!.step_id], models: [estimates[2]], judge, authorization: 'synthetic_no_production' });
    const candidate = JSON.stringify({ transcript: 'synthetic output', artifacts: { receipt: 'ok' } }); let dispatches = 0;
    const [receipt] = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-luna', checkpoint: createDailyOpsCheckpoint(), lock: createStrictSequentialLock(),
      runner: { capability: 'synthetic_no_production' as const, dispatch: async (input) => { dispatches += 1; return { ...result(input.step.step_id, 'success', ''), transcript: 'synthetic output', artifacts: { receipt: 'ok' } }; }, recover: async () => { throw new Error('not used'); } },
      judge: async () => ({ resolved: false, evidence: 'v1' }),
    });
    const revisedJudge = { ...judge, judge_version: '2026-08-12.2', prompt_hash: digest('judge prompt v2') };
    const rejudged = await rejudgeDailyOps({ receipt: receipt!, judge: revisedJudge, anonymousCandidate: candidate, runner: async () => ({ resolved: true, evidence: 'v2' }) });
    expect(dispatches).toBe(1); expect(rejudged.candidate_hash).toBe(receipt!.candidate_hash); expect(rejudged.generation).toBe(2); expect(rejudged.resolved).toBe(true); expect(rejudged.judge).toEqual(revisedJudge);
  });

  it('retains candidate failure versus harness invalidity and denies favorable-judge resolution', async () => {
    const selectedStepIds = workflow.steps.slice(0, 2).map((step) => step.step_id);
    const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: {}, selectedStepIds, models: [estimates[0]], judge, authorization: 'synthetic_no_production' });
    const [failed, invalid] = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpoint: createDailyOpsCheckpoint(), lock: createStrictSequentialLock(),
      runner: { capability: 'synthetic_no_production', dispatch: async (input) => input.step.step_id.endsWith('01')
        ? { ...result(input.step.step_id, 'failure', ''), transcript: 'failed', artifacts: { reason: 'candidate' } }
        : { ...result(input.step.step_id, 'failure', ''), terminal_class: 'harness_invalid', transcript: 'invalid', artifacts: { reason: 'harness' } },
        recover: async () => { throw new Error('not used'); } },
      judge: async () => ({ resolved: true, evidence: 'favorable but subordinate to candidate outcome' }),
    });
    expect(failed!.candidate_outcome).toEqual({ status: 'failure', terminal_class: 'step_failure' });
    expect(invalid!.candidate_outcome).toEqual({ status: 'failure', terminal_class: 'harness_invalid' });
    expect(failed!.judgement.resolved).toBe(false); expect(invalid!.judgement.resolved).toBe(false);
    const retained = JSON.stringify({ transcript: 'failed', artifacts: { reason: 'candidate' } });
    const rejudged = await rejudgeDailyOps({ receipt: failed!, judge: { ...judge, judge_version: '2026-08-12.2' }, anonymousCandidate: retained, runner: async () => ({ resolved: true, evidence: 'still favorable' }) });
    expect(rejudged.resolved).toBe(false);
  });

  it('binds the dispatch-disabled Aug. 12 four-model dry-run and spend estimate', async () => {
    const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: { date: '2026-08-12', mode: 'dry-run' }, models: estimates, judge, authorization: 'offline_unapproved' });
    expect(plan.models).toEqual(['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra', 'openai-codex/gpt-5.6-luna', 'zai/glm-5.2']);
    expect(plan.selected_step_ids).toHaveLength(13); expect(plan.scoring_ids).toHaveLength(13); expect(plan.resources).toEqual(resources);
    expect(plan.execution).toBe('strictly_sequential'); expect(plan.dispatch_permitted).toBe(false);
    expect(plan.estimated_total_usd).toBeCloseTo(88.9); expect(plan.estimated_total_runtime_ms).toBe(12 * 60 * 60_000);
    await expect(runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpoint: createDailyOpsCheckpoint(), lock: createStrictSequentialLock(), runner: {} as never, judge: async () => ({ resolved: true, evidence: '' }) })).rejects.toThrow('only synthetic no-production');
  });
});
