import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../contracts/canonical.js';
import type { AttemptV1 } from '../contracts/schemas.js';
import type { PublicKanbanClient } from '../kanban/client.js';
import type { ExecutionPlan } from '../planning/index.js';
import { createShadowKanban, doctorShadowKanban, sanitizeCandidateEnvironment } from '../shadow-kanban/index.js';
import { buildSnapshot, doctorSnapshot } from '../snapshot/index.js';
import type { PreparedAttempt } from './index.js';

export function createSnapshotPreparer(input: { projectRoot: string; workRoot: string; plan: ExecutionPlan; client: PublicKanbanClient }): (attempt: AttemptV1) => Promise<PreparedAttempt> {
  return async (attempt) => {
    await mkdir(input.workRoot, { recursive: true, mode: 0o700 });
    const repository = path.join(input.workRoot, attempt.attempt_id);
    const snapshot = await buildSnapshot({ sourceRepository: input.projectRoot, baseCommit: input.plan.case.case_ref.base_commit, destination: repository,
      excludedPaths: ['.juno_task', 'juno-benchmark/node_modules', 'juno-benchmark/dist'] });
    if (snapshot.content_identity !== input.plan.snapshot_hash) throw new Error('rebuilt snapshot identity differs from accepted plan');
    // Admission is not complete until the exported repository proves the isolation
    // contract. In particular, buildSnapshot alone intentionally does not scan the
    // selected historical tree for credentials or source/controller path leakage.
    await doctorSnapshot({
      repository,
      manifest: snapshot,
      sourceRepository: input.projectRoot,
      candidateEnvironment: sanitizeCandidateEnvironment(process.env, repository),
    });
    const source = await input.client.getRevisionedTask(input.plan.case.task_id);
    if (source.revision !== input.plan.case.task_revision) throw new Error('source task changed before shadow construction');
    const shadow = await createShadowKanban({ repository, selectedTask: source.task });
    for (const [wikiPath, expectedHash] of Object.entries(input.plan.wiki_hashes)) {
      const sourceWiki = path.join(input.projectRoot, '.juno_task', 'wiki', ...wikiPath.split('/'));
      const bytes = await readFile(sourceWiki);
      if (`sha256:${sha256Hex(bytes)}` !== expectedHash) throw new Error(`selected wiki changed after planning: ${wikiPath}`);
      const destination = path.join(repository, '.juno_task', 'wiki', ...wikiPath.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    await doctorShadowKanban({ repository, manifest: shadow });
    return {
      repository,
      snapshotHash: snapshot.content_identity,
      shadowHash: shadow.content_identity,
      baselineCommit: snapshot.synthetic_commit,
      baselineTree: snapshot.synthetic_tree,
    };
  };
}
