import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHash, sha256Hex } from '../../src/contracts/canonical.js';
import {
  createDailyOpsCheckpoint, createFileDailyOpsCheckpointStore, createStrictSequentialLock, deserializeDailyOpsCheckpoint,
  planDailyOps, rejudgeDailyOps, runSyntheticDailyOps, serializeDailyOpsCheckpoint,
  type DailyOpsCheckpoint, type DailyOpsCheckpointStore, type DailyOpsWorkflowDefinition, type WorkflowCandidateResult,
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

function memoryCheckpointStore(initial: DailyOpsCheckpoint = createDailyOpsCheckpoint()): DailyOpsCheckpointStore {
  let seed: DailyOpsCheckpoint | undefined = initial; let serialized: string | undefined;
  return { load: async (planId) => serialized === undefined ? (seed ?? createDailyOpsCheckpoint()) : deserializeDailyOpsCheckpoint(serialized, planId),
    save: async (planId, checkpoint) => { serialized = serializeDailyOpsCheckpoint(planId, checkpoint); seed = undefined; } };
}

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
    const first = workflow.steps[0]!;
    for (const altered of [
      { ...first, step_id: 'adversarial-step' },
      { ...first, scoring_id: 'adversarial-score' },
      { ...first, prompt: 'adversarial prompt' },
      { ...first, resources: ['DATA_2026_PROVIDER'] as const },
    ]) {
      expect(() => planDailyOps({ workflow: { ...workflow, steps: [altered, ...workflow.steps.slice(1)] }, definitionBytes, runDate: '2026-08-12', variables: {}, models: [estimates[0]], judge, authorization: 'synthetic_no_production' })).toThrow('workflow semantics do not match tracked definition bytes');
    }
    const changedSource = JSON.parse(definitionBytes.toString('utf8')) as { steps: Array<{ prompt: string }> };
    changedSource.steps[0]!.prompt = 'source drift'; const changedBytes = Buffer.from(JSON.stringify(changedSource));
    expect(() => planDailyOps({ workflow: { ...workflow, definition_hash: `sha256:${sha256Hex(changedBytes)}` }, definitionBytes: changedBytes, runDate: '2026-08-12', variables: {}, models: [estimates[0]], judge, authorization: 'synthetic_no_production' })).toThrow('workflow semantics do not match tracked definition bytes');
  });

  it('produces 13 sequential, redacted, session/cost/judge receipts and recovers a stall once', async () => {
    const secret = 'sk_test_SYNTHETIC_123456789';
    const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: { mode: 'synthetic', credential_marker: secret }, models: [estimates[1]], judge, authorization: 'synthetic_no_production' });
    const dispatches: string[] = []; const recoveries: string[] = []; const judged: string[] = [];
    const receipts = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-terra', checkpointStore: memoryCheckpointStore(), lock: createStrictSequentialLock(), trustedSecrets: [secret],
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

  it('persists stalled recovery across outage/restart without duplicate dispatch and rejects tampering/drift', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'daily-ops-checkpoint-')); const checkpointPath = path.join(directory, 'state.json');
    try {
      const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: {}, selectedStepIds: [workflow.steps[0]!.step_id], models: [estimates[0]], judge, authorization: 'synthetic_no_production' });
      let dispatchCount = 0; let recoveryCount = 0;
      const firstStore = createFileDailyOpsCheckpointStore(checkpointPath);
      await expect(runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: firstStore, lock: createStrictSequentialLock(),
        runner: { capability: 'synthetic_no_production', dispatch: async (input) => { dispatchCount += 1; return result(input.step.step_id, 'stalled', 'none'); },
          recover: async () => { recoveryCount += 1; throw new Error('synthetic outage'); } }, judge: async () => ({ resolved: true, evidence: 'unused' }),
      })).rejects.toThrow('synthetic outage');

      const restartedStore = createFileDailyOpsCheckpointStore(checkpointPath);
      const recovered = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: restartedStore, lock: createStrictSequentialLock(),
        runner: { capability: 'synthetic_no_production', dispatch: async () => { dispatchCount += 1; throw new Error('duplicate dispatch'); },
          recover: async (input) => { recoveryCount += 1; return result(input.step.step_id, 'success', 'none'); } }, judge: async () => ({ resolved: true, evidence: 'recovered' }),
      });
      const replayed = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: createFileDailyOpsCheckpointStore(checkpointPath), lock: createStrictSequentialLock(),
        runner: { capability: 'synthetic_no_production', dispatch: async () => { throw new Error('terminal redispatch'); }, recover: async () => { throw new Error('terminal recovery'); } },
        judge: async () => { throw new Error('terminal rejudge'); },
      });
      expect(dispatchCount).toBe(1); expect(recoveryCount).toBe(2); expect(replayed).toEqual(recovered);

      const valid = await readFile(checkpointPath, 'utf8');
      await expect(createFileDailyOpsCheckpointStore(checkpointPath).load(digest('other plan'))).rejects.toThrow('plan/schema drift');
      const tampered = JSON.parse(valid) as { payload: { dispatch_intents: unknown[] } }; tampered.payload.dispatch_intents.push(['forged', { dispatch_id: 'forged', invocation_hash: digest('forged') }]);
      await writeFile(checkpointPath, JSON.stringify(tampered));
      await expect(createFileDailyOpsCheckpointStore(checkpointPath).load(plan.plan_id)).rejects.toThrow('integrity verification failed');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('recovers an intent-only dispatch outage idempotently and rejects rebound intent tampering', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'daily-ops-intent-outage-')); const checkpointPath = path.join(directory, 'state.json');
    try {
      const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: {}, selectedStepIds: [workflow.steps[0]!.step_id], models: [estimates[0]], judge, authorization: 'synthetic_no_production' });
      let dispatchCount = 0; let recoveryCount = 0;
      await expect(runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: createFileDailyOpsCheckpointStore(checkpointPath), lock: createStrictSequentialLock(),
        runner: { capability: 'synthetic_no_production', dispatch: async () => { dispatchCount += 1; throw new Error('interrupted after synthetic side effect'); },
          recover: async () => { throw new Error('recovery belongs to restart'); } }, judge: async () => ({ resolved: true, evidence: 'unused' }),
      })).rejects.toThrow('interrupted after synthetic side effect');

      const [recovered] = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: createFileDailyOpsCheckpointStore(checkpointPath), lock: createStrictSequentialLock(),
        runner: { capability: 'synthetic_no_production', dispatch: async () => { dispatchCount += 1; throw new Error('duplicate dispatch'); },
          recover: async (input) => { recoveryCount += 1; expect(input.previous).toBeUndefined(); return result(input.step.step_id, 'success', 'none'); } },
        judge: async () => ({ resolved: true, evidence: 'intent-only recovery' }),
      });
      expect(dispatchCount).toBe(1); expect(recoveryCount).toBe(1);
      expect(recovered!.recovery).toEqual({ state: 'recovered', dispatch_count: 1, recovery_count: 1 });

      const envelope = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        payload: { dispatch_intents: Array<[string, { dispatch_id: string; invocation_hash: `sha256:${string}` }]> };
        integrity_hash: `sha256:${string}`;
      };
      envelope.payload.dispatch_intents[0]![1].invocation_hash = digest('rebound invocation');
      envelope.integrity_hash = canonicalHash(envelope.payload);
      await writeFile(checkpointPath, JSON.stringify(envelope));
      await expect(runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: createFileDailyOpsCheckpointStore(checkpointPath), lock: createStrictSequentialLock(),
        runner: { capability: 'synthetic_no_production', dispatch: async () => { throw new Error('tamper dispatch'); }, recover: async () => { throw new Error('tamper recovery'); } },
        judge: async () => { throw new Error('tamper judge'); },
      })).rejects.toThrow('dispatch intent binding is invalid');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejudges retained candidate truth without exposing a candidate dispatch API', async () => {
    const plan = planDailyOps({ workflow, definitionBytes, runDate: '2026-08-12', variables: {}, selectedStepIds: [workflow.steps[0]!.step_id], models: [estimates[2]], judge, authorization: 'synthetic_no_production' });
    const candidate = JSON.stringify({ transcript: 'synthetic output', artifacts: { receipt: 'ok' } }); let dispatches = 0;
    const [receipt] = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-luna', checkpointStore: memoryCheckpointStore(), lock: createStrictSequentialLock(),
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
    const [failed, invalid] = await runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: memoryCheckpointStore(), lock: createStrictSequentialLock(),
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
    await expect(runSyntheticDailyOps({ plan, model: 'openai-codex/gpt-5.6-sol', checkpointStore: memoryCheckpointStore(), lock: createStrictSequentialLock(), runner: {} as never, judge: async () => ({ resolved: true, evidence: '' }) })).rejects.toThrow('only synthetic no-production');
  });
});
