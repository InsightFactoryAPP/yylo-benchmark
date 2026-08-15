import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLongitudinalReport, generateLongitudinalReport } from '../../src/reporting/index.js';
import { retainedFixture } from './retained-fixture.js';

const h = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;
describe('longitudinal reports', () => {
  it('unions compatible old/new models without rerunning candidates and exposes separate uncertain metrics', async () => {
    const item = await retainedFixture(); await item.addAttempt({ model: ':mini', resolved: true, cost: { completeness: 'complete', usd: 1 } }); await item.addAttempt({ model: ':sol', resolved: false, cost: { completeness: 'unavailable', usd: null } });
    const report = await buildLongitudinalReport({ client: item.client, registry: item.registry, taskId: 'CASE1' });
    expect(item.candidateInvocations()).toBe(0); expect(report.cohorts).toHaveLength(1); expect(report.cohorts[0]?.attempt_count).toBe(2);
    expect(report.cohorts[0]?.systems.map((system) => system.system.model)).toEqual([':mini', ':sol']);
    expect(report.cohorts[0]?.systems[0]).toMatchObject({ sample_size: 1, resolved: { numerator: 1, denominator: 1 }, invalid: { numerator: 0, denominator: 1 }, runtime: { mean_ms: 1000 }, cost: { cost_per_success_usd: 1, cost_per_success_completeness: 'complete' } });
    expect(report.cohorts[0]?.systems[1]?.cost).toMatchObject({ unavailable_attempts: 1, cost_per_success_usd: null }); expect(report).not.toHaveProperty('blended_score');
  });

  it('separates incompatible inputs and layers report versions without changing experiment manifests', async () => {
    const item = await retainedFixture(); const firstPlan = await item.addAttempt({ model: ':mini' }); const secondPlan = await item.addAttempt({ model: ':sol', budget: h('9') });
    const beforeFirst = await item.registry.verifyExperiment(firstPlan.plan_id.slice(7)); const beforeSecond = await item.registry.verifyExperiment(secondPlan.plan_id.slice(7));
    const first = await generateLongitudinalReport({ client: item.client, registry: item.registry, taskId: 'CASE1', reportVersion: 'report.v1' }); const second = await generateLongitudinalReport({ client: item.client, registry: item.registry, taskId: 'CASE1', reportVersion: 'report.v2' });
    expect(first.report.cohorts).toHaveLength(2); expect(first.report.incompatibilities).toHaveLength(1); expect(first.report.report_id).not.toBe(second.report.report_id);
    expect(await item.registry.verifyExperiment(firstPlan.plan_id.slice(7))).toEqual(beforeFirst); expect(await item.registry.verifyExperiment(secondPlan.plan_id.slice(7))).toEqual(beforeSecond);
  });

  it('fails closed when a retained object is tampered', async () => {
    const item = await retainedFixture(); const plan = await item.addAttempt({ model: ':mini' }); const result = (await item.registry.verifyExperiment(plan.plan_id.slice(7))).find((entry) => entry.role === 'normalized-result')!;
    const objectPath = path.join(item.registry.root, result.path); await chmod(objectPath, 0o600); await writeFile(objectPath, '{}');
    await expect(buildLongitudinalReport({ client: item.client, registry: item.registry, taskId: 'CASE1' })).rejects.toThrow(/verification failed/u);
  });
});
