import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHash } from '../../src/contracts/canonical.js';
import type { AttemptV1, NormalizedResultV1 } from '../../src/contracts/schemas.js';
import { gradeRetainedAttempt, verifyGraderReceiptValue, verifyRequiredGraderReceipt } from '../../src/grading/index.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';

const h = `sha256:${'1'.repeat(64)}` as const;
const attempt: AttemptV1 = { schema_version: 'juno_benchmark_attempt.v1', attempt_id: 'A1', experiment_id: 'E1', case_input_hash: h,
  snapshot_hash: h, prompt_hash: h, agent: 'yylo', provider: 'openai', model: 'openai/gpt-mini', tool_policy_hash: h,
  budget_hash: h, package_version: '1', juno_version: '2', session_topology: 'fresh' };
const candidate: NormalizedResultV1 = { schema_version: 'juno_benchmark_normalized_result.v1', attempt_id: 'A1', resolved: false,
  terminal_class: 'model_failure', session_id: 'S1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z',
  elapsed_ms: 1000, cost: { completeness: 'complete', usd: 0 }, patch_hash: h, terminal_evidence_hash: h };

async function registry() { return new ImmutableArtifactRegistry(await mkdtemp(path.join(os.tmpdir(), 'grader-receipt-'))); }

describe('governed grading receipts', () => {
  it('does not accept candidate success and fails closed when the required grader is missing', async () => {
    const store = await registry();
    const result = await gradeRetainedAttempt({ registry: store, experimentId: 'E1', attempt, profile: 'focused', candidateResult: candidate, candidateSucceeded: true });
    expect(result).toMatchObject({ resolved: false, terminal_class: 'grader_failure' });
    await expect(verifyRequiredGraderReceipt(store, (await store.verifyExperiment('E1')).filter((entry) => entry.role !== 'grader-receipt'), 'A1')).rejects.toThrow(/missing/u);
  });

  it('binds input/output/identity and supports regrading retained evidence', async () => {
    const store = await registry();
    const failed = await gradeRetainedAttempt({ registry: store, experimentId: 'E1', attempt, profile: 'focused', candidateResult: candidate, candidateSucceeded: true,
      runner: async () => ({ graderId: 'tests', graderVersion: '1', passed: false, output: { passed: false } }) });
    const passed = await gradeRetainedAttempt({ registry: store, experimentId: 'E1', attempt, profile: 'focused', candidateResult: candidate, candidateSucceeded: true,
      runner: async () => ({ graderId: 'tests', graderVersion: '2', passed: true, output: { passed: true } }) });
    expect(failed.terminal_class).toBe('grader_failure'); expect(passed.terminal_class).toBe('resolved');
    expect((await store.verifyExperiment('E1')).filter((entry) => entry.role === 'grader-receipt')).toHaveLength(2);
  });

  it('rejects a tampered receipt even when its shape remains valid', () => {
    const core = { schema_version: 'juno_benchmark_grader_receipt.v1' as const, attempt_id: 'A1', grader_profile: 'focused', grader_id: 'g', grader_version: '1', required: true as const,
      passed: true, input_hash: h, output_hash: h, result_hash: h };
    const receipt = { ...core, integrity_hash: canonicalHash(core) };
    expect(() => verifyGraderReceiptValue({ ...receipt, passed: false })).toThrow(/integrity/u);
  });
});
