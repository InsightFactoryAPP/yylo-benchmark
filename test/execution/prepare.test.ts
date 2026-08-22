import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSnapshotPreparer } from '../../src/execution/prepare.js';
import type { AttemptV1 } from '../../src/contracts/schemas.js';
import type { ExecutionPlan } from '../../src/planning/index.js';
import type { PublicKanbanClient } from '../../src/kanban/client.js';
import { buildSnapshot } from '../../src/snapshot/index.js';
import { optedInTask } from '../kanban/fake-cli.js';
import { git, makeSourceRepository } from '../snapshot/real-git.js';

const hash = `sha256:${'1'.repeat(64)}` as const;

describe('attempt snapshot admission', () => {
  it('runs the isolation doctor and refuses credential-like historical bytes before dispatch', async () => {
    const source = await makeSourceRepository();
    await writeFile(path.join(source.root, 'leaked.env'), 'api_key=abcdefghijklmnop\n');
    await git(source.root, 'add', 'leaked.env');
    await git(source.root, 'commit', '--quiet', '-m', 'credential fixture');
    const commit = await git(source.root, 'rev-parse', 'HEAD');
    const scratch = path.join(await mkdtemp(path.join(os.tmpdir(), 'benchmark-plan-snapshot-')), 'repository');
    const manifest = await buildSnapshot({ sourceRepository: source.root, baseCommit: commit, destination: scratch, excludedPaths: ['.juno_task', 'juno-benchmark/node_modules', 'juno-benchmark/dist'] });
    await rm(path.dirname(scratch), { recursive: true, force: true });

    const task = optedInTask();
    const plan = {
      schema_version: 'juno_benchmark_plan.v1', plan_id: hash,
      case: { schema_version: 'juno_benchmark_eval_case.v1', task_id: task.id, task_revision: '1'.repeat(64), task_hash: hash, prompt_hash: hash, input_hash: hash,
        case_ref: { ...(task.fields.benchmark as object), base_commit: commit } },
      models: ['openai/gpt-mini'], model_selectors: { 'openai/gpt-mini': ':mini' }, attempts: 1, snapshot_hash: manifest.content_identity, wiki_hashes: {},
      tool_policy_hash: hash, budget_hash: hash, package_version: '0.1.0', juno_version: '2.1.2',
      isolation: { git_objects: 'isolated', host_filesystem: 'trusted', container: 'none' },
    } as ExecutionPlan;
    const attempt = { schema_version: 'juno_benchmark_attempt.v1', attempt_id: 'A1', experiment_id: hash,
      case_input_hash: hash, snapshot_hash: manifest.content_identity, prompt_hash: hash, agent: 'yylo', provider: 'openai', model: 'openai/gpt-mini',
      tool_policy_hash: hash, budget_hash: hash, package_version: '0.1.0', juno_version: '2.1.2', session_topology: 'fresh' } as AttemptV1;
    const client = { getRevisionedTask: async () => ({ task, revision: '1'.repeat(64) }) } as unknown as PublicKanbanClient;
    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'benchmark-attempt-work-'));
    const prepare = createSnapshotPreparer({ projectRoot: source.root, workRoot, plan, client });
    await expect(prepare(attempt)).rejects.toThrow(/credential-like bytes/u);
  });
});
