import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintBenchmarkCase } from '../src/case/lint.js';
import { loadConfig } from '../src/config/index.js';
import { PublicKanbanClient, type KanbanTask } from '../src/kanban/client.js';

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 'CASE1', status: 'done', body: 'Fix the deterministic bug.',
    last_modified: '2026-08-12T00:00:00Z', commit_hash: 'b'.repeat(40),
    feature_tags: ['benchmark-case'], related_tasks: [], blocked_by: [],
    fields: { benchmark: {
      schema_version: 'juno_benchmark_case_ref.v1', eligible: true, case_version: 1,
      repository_id: 'root', base_commit: 'a'.repeat(40), category: 'backend',
      grader_profile: 'focused-tests', wiki_paths: [],
    } },
    ...overrides,
  };
}

describe('benchmark case lint', () => {
  it('is deterministic for an exact task revision', () => {
    const first = lintBenchmarkCase(task());
    const second = lintBenchmarkCase(task());
    expect(first).toEqual(second);
    expect(first.task_revision).toBe('2026-08-12T00:00:00Z');
    expect(first.task_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('refuses ordinary and malformed tasks', () => {
    expect(() => lintBenchmarkCase(task({ feature_tags: [] }))).toThrow(/missing benchmark-case tag/u);
    expect(() => lintBenchmarkCase(task({ fields: {} }))).toThrow(/fields.benchmark/u);
  });

  it('reads only public CLI JSON and closes stdin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-case-'));
    const fixture = path.join(root, 'kanban-fixture.mjs');
    await writeFile(fixture, `if (process.argv.slice(2).join(' ') !== 'get CASE1 -f json') process.exit(9);\nprocess.stdout.write(JSON.stringify([${JSON.stringify(task())}]));\n`, 'utf8');
    await chmod(fixture, 0o700);
    await writeFile(path.join(root, 'juno-benchmark.config.json'), JSON.stringify({
      schema_version: 'juno_benchmark_config.v1', repository_id: 'root',
      kanban: { executable: process.execPath, arguments: [fixture] },
    }), 'utf8');
    const loaded = await loadConfig({ cwd: root });
    const fetched = await new PublicKanbanClient(loaded).getTask('CASE1');
    expect(lintBenchmarkCase(fetched).task_id).toBe('CASE1');
  });
});
