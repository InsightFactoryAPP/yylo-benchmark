import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublicKanbanClient } from '../../src/kanban/client.js';
import { installFakeKanban, optedInTask, type FakeState } from './fake-cli.js';

async function fixture(overrides: Partial<FakeState> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-kanban-'));
  const revision = '1'.repeat(64);
  const installed = await installFakeKanban(root, { tasks: { CASE1: optedInTask() }, revisions: { CASE1: revision }, ...overrides });
  return { ...installed, client: new PublicKanbanClient(installed.loaded), revision };
}

describe('public Kanban control plane', () => {
  it('uses versioned CLI JSON, exact ledger revision, closed stdin, and complete create receipt', async () => {
    const { client, revision, callsPath } = await fixture();
    const source = await client.getRevisionedTask('CASE1');
    expect(source.revision).toBe(revision);
    const created = await client.createRelatedRecord({ kind: 'experiment', sourceTaskId: 'CASE1', sourceRevision: revision, recordId: 'PLAN1', benchmark: { schema_version: 'fixture.v1', record_id: 'PLAN1' } });
    expect(created.task.feature_tags).toEqual(['benchmark-experiment']);
    expect(created.task.related_tasks).toContain('CASE1');
    expect(created.receipt).toMatchObject({ operation: 'create', before_sha256: null, task_id: created.task.id });
    const calls = await readFile(callsPath, 'utf8');
    expect(calls).toContain('"--version"'); expect(calls).toContain('"--receipt-file"'); expect(calls).toContain('"--reject-duplicates"');
    const parsed = calls.trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(parsed.filter((args) => args[0] !== '--version').every(
      (args) => args[0] === '-f' && args[1] === 'json')).toBe(true);
  });

  it('normalizes legacy null relationship fields but rejects malformed values', async () => {
    const legacy = optedInTask() as unknown as Record<string, unknown>;
    legacy.related_tasks = null; legacy.blocked_by = null;
    const accepted = await fixture({ tasks: { CASE1: legacy as never } });
    await expect(accepted.client.getTask('CASE1')).resolves.toMatchObject({ related_tasks: [], blocked_by: [] });
    legacy.related_tasks = 'CASE2';
    const malformed = await fixture({ tasks: { CASE1: legacy as never } });
    await expect(malformed.client.getTask('CASE1')).rejects.toThrow();
  });

  it('fails closed on a concurrent source read and stale expected update', async () => {
    const concurrent = await fixture({ mutateDuringRead: true });
    await expect(concurrent.client.getRevisionedTask('CASE1')).rejects.toThrow(/changed concurrently/u);
    const normal = await fixture();
    await expect(normal.client.updateBenchmarkField('CASE1', '2'.repeat(64), { record_id: 'x' })).rejects.toThrow(/stale task revision/u);
  });

  it('rejects missing and dishonest mutation receipts', async () => {
    const missing = await fixture({ omitReceipt: true });
    await expect(missing.client.createRelatedRecord({ kind: 'experiment', sourceTaskId: 'CASE1', sourceRevision: missing.revision, recordId: 'P1', benchmark: { record_id: 'P1' } })).rejects.toThrow(/did not produce a valid receipt/u);
    const bad = await fixture({ badReceipt: true });
    await expect(bad.client.createRelatedRecord({ kind: 'experiment', sourceTaskId: 'CASE1', sourceRevision: bad.revision, recordId: 'P2', benchmark: { record_id: 'P2' } })).rejects.toThrow(/changed concurrently after mutation/u);
  });

  it('finds an already-created related record for recovery and refuses duplicates', async () => {
    const item = await fixture();
    await item.client.createRelatedRecord({ kind: 'investigation', sourceTaskId: 'CASE1', sourceRevision: item.revision, recordId: 'INV1', benchmark: { record_id: 'INV1', source_task_id: 'CASE1' } });
    const found = await item.client.findRelatedRecord({ kind: 'investigation', sourceTaskId: 'CASE1', recordId: 'INV1' });
    expect(found?.task.fields['benchmark']).toMatchObject({ record_id: 'INV1' });
    expect((await item.client.listRelatedRecords('investigation', 'CASE1')).map((record) => record.task.id)).toEqual([found?.task.id]);
    const state = JSON.parse(await readFile(item.statePath, 'utf8')) as FakeState;
    await writeFile(item.statePath, JSON.stringify({ ...state, records: ['REC1'] }), 'utf8');
    await expect(item.client.createRelatedRecord({ kind: 'investigation', sourceTaskId: 'CASE1', sourceRevision: item.revision, recordId: 'INV1', benchmark: { record_id: 'INV1' } })).rejects.toThrow(/duplicate task/u);
  });
});
