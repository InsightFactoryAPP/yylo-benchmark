import { describe, expect, it } from 'vitest';
import { reconcileJunoTelemetry } from '../../src/telemetry/index.js';

const base = {
  attemptId: 'A1', expectedModel: 'openai/gpt-mini', expectedJunoVersion: '2.0.0', observedJunoVersion: '2.0.0',
  startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000,
  exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', patchHash: null,
} as const;
const envelope = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: 'juno_execution_envelope.v1', status: 'success', session_id: 'S1', provider: 'openai', model: 'gpt-mini',
  juno_version: '2.0.0', cost: { completeness: 'complete', usd: 0 }, ...overrides,
});

describe('public Juno execution envelope reconciliation', () => {
  it('preserves genuine zero and all explicit cost semantics', () => {
    expect(reconcileJunoTelemetry({ ...base, stdout: envelope() }).result.cost).toEqual({ completeness: 'complete', usd: 0 });
    for (const cost of [{ completeness: 'partial', usd: 1.25 }, { completeness: 'unavailable', usd: null }, { completeness: 'not_applicable', usd: null }]) {
      expect(reconcileJunoTelemetry({ ...base, stdout: envelope({ cost }) }).result.cost).toEqual(cost);
    }
  });

  it.each([
    ['openai-codex/gpt-5.6-sol', 'openai-codex', 'gpt-5.6-sol'],
    ['openai-codex/gpt-5.6-mini', 'openai-codex', 'gpt-5.6-mini'],
    ['openai-codex/gpt-5.6-luna', 'openai-codex', 'gpt-5.6-luna'],
    ['zai/glm-5.2', 'zai', 'glm-5.2'],
  ])('normalizes planned %s against separately observed identity', (expectedModel, provider, model) => {
    const result = reconcileJunoTelemetry({ ...base, expectedModel, stdout: envelope({ provider, model }) });
    expect(result).toMatchObject({ provider, model, candidateSucceeded: true });
    expect(result.result.terminal_class).toBe('model_failure');
  });

  it('never promotes a candidate-only success claim to resolution', () => {
    const result = reconcileJunoTelemetry({ ...base, stdout: `${envelope()}\n${JSON.stringify({ resolved: true })}` });
    expect(result.result).toMatchObject({ resolved: false, terminal_class: 'harness_failure' });
  });

  it('fails closed on absent output, identity drift, version drift, and provider failure', () => {
    expect(reconcileJunoTelemetry({ ...base, stdout: 'ordinary logs' }).result.terminal_class).toBe('harness_failure');
    expect(reconcileJunoTelemetry({ ...base, stdout: envelope({ model: 'gpt-sol' }) }).result.terminal_class).toBe('harness_failure');
    expect(reconcileJunoTelemetry({ ...base, stdout: envelope({ juno_version: '2.0.1' }) }).result.terminal_class).toBe('harness_failure');
    expect(reconcileJunoTelemetry({ ...base, exitCode: 1, stdout: envelope({ status: 'failure' }) }).result.terminal_class).toBe('model_failure');
  });
});
