import { describe, expect, it } from 'vitest';
import { BenchmarkCaseRefV1Schema, CostEvidenceSchema, NormalizedResultV1Schema } from '../src/contracts/schemas.js';

const digest = `sha256:${'a'.repeat(64)}`;

describe('versioned contracts', () => {
  it('accepts the PDR case reference and rejects unsafe wiki paths', () => {
    const value = {
      schema_version: 'juno_benchmark_case_ref.v1', eligible: true, case_version: 1,
      repository_id: 'root', base_commit: 'a'.repeat(40), category: 'backend',
      grader_profile: 'focused-tests', wiki_paths: ['juno-benchmark/project/backend.md'],
    };
    expect(BenchmarkCaseRefV1Schema.parse(value)).toEqual(value);
    expect(() => BenchmarkCaseRefV1Schema.parse({ ...value, wiki_paths: ['../hidden.md'] })).toThrow();
    expect(() => BenchmarkCaseRefV1Schema.parse({ ...value, unknown: true })).toThrow();
  });

  it('never represents missing cost as zero', () => {
    expect(CostEvidenceSchema.parse({ completeness: 'complete', usd: 0 })).toEqual({ completeness: 'complete', usd: 0 });
    expect(() => CostEvidenceSchema.parse({ completeness: 'unavailable', usd: 0 })).toThrow();
    expect(CostEvidenceSchema.parse({ completeness: 'unavailable', usd: null })).toEqual({ completeness: 'unavailable', usd: null });
  });

  it('requires resolved truth to agree with terminal classification', () => {
    const result = {
      schema_version: 'juno_benchmark_normalized_result.v1', attempt_id: 'a1', resolved: true,
      terminal_class: 'resolved', session_id: 's1', started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:01.000Z', elapsed_ms: 1000,
      cost: { completeness: 'complete', usd: 0 }, patch_hash: null, terminal_evidence_hash: digest,
    };
    expect(NormalizedResultV1Schema.parse(result).resolved).toBe(true);
    expect(() => NormalizedResultV1Schema.parse({ ...result, terminal_class: 'model_failure' })).toThrow(/resolved/u);
  });
});
