import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublicKanbanClient } from '../../src/kanban/client.js';
import { acceptPlan, parseBenchmarkPlan, planExperiment, recordInvestigation, type PlanInputs } from '../../src/planning/index.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { installFakeKanban, optedInTask, type FakeState } from '../kanban/fake-cli.js';

const h = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;
const inputs: Omit<PlanInputs, 'taskId'> = { models: ['openai/gpt-sol', 'openai/gpt-mini'], modelSelectors: { 'openai/gpt-sol': ':sol', 'openai/gpt-mini': ':mini' }, attempts: 3, snapshotHash: h('2'), wikiHashes: { 'juno-benchmark/project/backend.md': h('3') }, toolPolicyHash: h('4'), budgetHash: h('5'), packageVersion: '0.1.0', junoVersion: '2.0.0' };
async function fixture(task = optedInTask()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-plan-')); const revision = '1'.repeat(64);
  const fake = await installFakeKanban(root, { tasks: { CASE1: task }, revisions: { CASE1: revision } });
  return { root, revision, fake, client: new PublicKanbanClient(fake.loaded), registry: new ImmutableArtifactRegistry(path.join(root, 'private-registry')) };
}

describe('revision-bound benchmark planning', () => {
  it('is deterministic, requires opt-in, and dry-run performs no mutation', async () => {
    const item = await fixture();
    const first = await planExperiment(item.client, { taskId: 'CASE1', ...inputs }); const second = await planExperiment(item.client, { taskId: 'CASE1', ...inputs });
    expect(first).toEqual(second); expect(parseBenchmarkPlan(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(first.models).toEqual(['openai/gpt-mini', 'openai/gpt-sol']);
    expect(first.model_selectors).toEqual({ 'openai/gpt-mini': ':mini', 'openai/gpt-sol': ':sol' }); expect(first.case.task_revision).toBe(item.revision);
    await expect(stat(path.join(item.root, 'private-registry'))).rejects.toMatchObject({ code: 'ENOENT' });
    const calls = await readFile(item.fake.callsPath, 'utf8'); expect(calls).not.toContain('"create"');
    const ordinary = await fixture({ ...optedInTask(), feature_tags: [] });
    await expect(planExperiment(ordinary.client, { taskId: 'CASE1', ...inputs })).rejects.toThrow(/missing benchmark-case tag/u);
  });

  it('rejects unresolved aliases before creating an immutable plan', async () => {
    const item = await fixture();
    await expect(planExperiment(item.client, { taskId: 'CASE1', ...inputs, models: [':mini'] })).rejects.toThrow(/exact provider\/model/u);
  });

  it('accepts one canonical related experiment, retains receipts, and recovers without duplication', async () => {
    const item = await fixture(); const plan = await planExperiment(item.client, { taskId: 'CASE1', ...inputs });
    const accepted = await acceptPlan(item.client, item.registry, plan);
    expect(accepted.canonical).toBe(true); expect(accepted.record?.task.feature_tags).toContain('benchmark-experiment');
    expect(await item.registry.verifyExperiment(plan.plan_id.slice(7))).toHaveLength(2);
    const recovered = await acceptPlan(item.client, item.registry, plan);
    expect(recovered).toMatchObject({ canonical: true, recovered: true, record: null });
    const state = JSON.parse(await readFile(item.fake.statePath, 'utf8')) as FakeState; expect(state.records).toHaveLength(1);
  });

  it('recovers a canonical create interrupted before local receipt/index persistence', async () => {
    const item = await fixture(); const plan = await planExperiment(item.client, { taskId: 'CASE1', ...inputs });
    await item.client.createRelatedRecord({ kind: 'experiment', sourceTaskId: 'CASE1', sourceRevision: item.revision, recordId: plan.plan_id, benchmark: { record_id: plan.plan_id, plan_hash: plan.plan_id } });
    const recovered = await acceptPlan(item.client, item.registry, plan);
    expect(recovered.recovered).toBe(true);
    const entries = await item.registry.verifyExperiment(plan.plan_id.slice(7));
    expect(entries.map((entry) => entry.role)).toEqual(['execution-plan', 'kanban-recovery-observation']);
  });

  it('makes --no-record explicit and non-canonical for local/fixture use', async () => {
    const item = await fixture(); const plan = await planExperiment(item.client, { taskId: 'CASE1', ...inputs });
    await expect(acceptPlan(item.client, item.registry, plan, { noRecord: true } as never)).rejects.toThrow(/explicit fixture or local/u);
    const result = await acceptPlan(item.client, item.registry, plan, { noRecord: true, nonCanonicalScope: 'fixture' });
    expect(result).toMatchObject({ canonical: false, record: null });
    const calls = await readFile(item.fake.callsPath, 'utf8'); expect(calls).not.toContain('"create"');
  });

  it('fails closed if the exact task revision becomes stale before acceptance', async () => {
    const item = await fixture(); const plan = await planExperiment(item.client, { taskId: 'CASE1', ...inputs });
    const state = JSON.parse(await readFile(item.fake.statePath, 'utf8')) as FakeState; state.revisions.CASE1 = '9'.repeat(64); await writeFile(item.fake.statePath, JSON.stringify(state));
    await expect(acceptPlan(item.client, item.registry, plan)).rejects.toThrow(/stale benchmark case/u);
    await expect(stat(path.join(item.root, 'private-registry'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a related investigation record without changing historical evidence', async () => {
    const item = await fixture(); const plan = await planExperiment(item.client, { taskId: 'CASE1', ...inputs });
    const evidence = await item.registry.put('investigation', 'bounded analysis');
    const record = await recordInvestigation(item.client, item.registry, { plan, investigationId: 'INV1', questionHash: h('6'), artifact: evidence });
    expect(record.task.feature_tags).toContain('benchmark-investigation'); expect(record.task.related_tasks).toContain('CASE1');
    expect((await item.registry.read(evidence)).toString()).toBe('bounded analysis');
  });
});
