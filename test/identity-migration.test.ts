import { describe, expect, it } from 'vitest';
import { migrateLegacyBenchmarkEnvironment } from '../src/identity.js';

describe('YYLO Benchmark identity migration', () => {
  it('maps legacy environment input without overriding canonical values', () => {
    const environment: NodeJS.ProcessEnv = {
      JUNO_BENCHMARK_REGISTRY: '/legacy',
      JUNO_BENCHMARK_WORK_ROOT: '/legacy-work',
      YYLO_BENCHMARK_WORK_ROOT: '/canonical-work',
    };
    migrateLegacyBenchmarkEnvironment(environment);
    expect(environment.YYLO_BENCHMARK_REGISTRY).toBe('/legacy');
    expect(environment.YYLO_BENCHMARK_WORK_ROOT).toBe('/canonical-work');
  });
});
