import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KanbanTask } from '../../src/kanban/client.js';
import { createShadowKanban, doctorShadowKanban, sanitizeCandidateEnvironment } from '../../src/shadow-kanban/index.js';

const exec = promisify(execFile);

function task(id: string, related: string[] = []): KanbanTask {
  return {
    id, status: 'in_progress', body: `Implement declared task ${id}.`,
    created_date: '2026-08-12T00:00:00Z', last_modified: '2026-08-12T00:00:00Z',
    commit_hash: null, agent_response: '', schema_version: 1,
    feature_tags: ['benchmark-case'], related_tasks: related, blocked_by: [],
    fields: { benchmark_context: true },
  };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-shadow-'));
  await exec('git', ['init', '--quiet', root]);
  return root;
}

describe('candidate shadow Kanban', () => {
  it('contains exactly selected and explicitly declared related context', async () => {
    const root = await repository();
    const manifest = await createShadowKanban({
      repository: root,
      selectedTask: task('CASE01', ['CTX001', 'NOT_DECLARED']),
      relatedTasks: [task('CTX001')],
    });
    expect(manifest.declared_task_ids).toEqual(['CASE01', 'CTX001']);
    expect(manifest).toMatchObject({ writable: true, retained: true, canonical_routing: 'absent' });
    await expect(doctorShadowKanban({ repository: root, manifest, canonicalControllerPaths: ['/canonical/controller'] })).resolves.toEqual({ ok: true, content_identity: manifest.content_identity });
    const config = await readFile(path.join(root, '.juno_task', 'tasks', 'config.json'), 'utf8');
    expect(config).not.toContain('/canonical/controller');
    expect(config).not.toContain('NOT_DECLARED');
    expect(await readFile(path.join(root, '.juno_task', 'tasks', 'ca', 'CASE01.md'), 'utf8')).not.toContain('NOT_DECLARED');
    expect((await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root })).stdout).toBe('');
  });

  it('routes candidate writes only to the retained local board with a fake public CLI', async () => {
    const root = await repository();
    const manifest = await createShadowKanban({ repository: root, selectedTask: task('CASE01') });
    const canonical = path.join(await mkdtemp(path.join(os.tmpdir(), 'juno-canonical-sentinel-')), 'task.md');
    await writeFile(canonical, 'canonical unchanged\n');
    const fake = path.join(root, 'fake-kanban.sh');
    await writeFile(fake, `#!/bin/sh
set -eu
[ "\${JUNO_TASK_ROOT+x}" != x ] || exit 71
[ "$1" = -c ] || exit 72
case "$2" in "$PWD/.juno_task/tasks/config.json") ;; *) exit 73;; esac
shift 2
[ "$1" = mark ] || exit 74
printf '\\nlocal candidate write\\n' >> "$PWD/.juno_task/tasks/ca/CASE01.md"
printf '%s\\n' "$*" > "$PWD/.juno_task/write-receipt.txt"
`, { mode: 0o700 });
    await chmod(fake, 0o700);
    const wrapper = path.join(root, '.juno_task', 'scripts', 'kanban.sh');
    await exec(wrapper, ['mark', 'done', '--id', 'CASE01'], {
      cwd: root,
      env: { ...process.env, JUNO_TASK_ROOT: path.dirname(canonical), JUNO_KANBAN_COMMAND: '/canonical/wrapper', JUNO_BENCHMARK_SHADOW_KANBAN_EXECUTABLE: fake },
    });
    expect(await readFile(canonical, 'utf8')).toBe('canonical unchanged\n');
    expect(await readFile(path.join(root, '.juno_task', 'tasks', 'ca', 'CASE01.md'), 'utf8')).toContain('local candidate write');
    expect(await readFile(path.join(root, '.juno_task', 'write-receipt.txt'), 'utf8')).toContain('mark done --id CASE01');
    await expect(doctorShadowKanban({ repository: root, manifest })).resolves.toMatchObject({ ok: true });
  });

  it('refuses alternate config routing and undeclared task injection', async () => {
    const root = await repository();
    const manifest = await createShadowKanban({ repository: root, selectedTask: task('CASE01') });
    const wrapper = path.join(root, '.juno_task', 'scripts', 'kanban.sh');
    await expect(exec(wrapper, ['--config=/canonical/tasks.json'], { cwd: root })).rejects.toMatchObject({ code: 64 });
    await mkdir(path.join(root, '.juno_task', 'tasks', 'ev'));
    await writeFile(path.join(root, '.juno_task', 'tasks', 'ev', 'EVIL01.md'), 'undeclared');
    await expect(doctorShadowKanban({ repository: root, manifest })).rejects.toThrow(/undeclared or missing/u);
  });

  it('sanitizes controller, Git-routing, provider and credential environment', () => {
    const clean = sanitizeCandidateEnvironment({
      PATH: '/bin', SAFE_FLAG: 'yes', JUNO_TASK_ROOT: '/canonical',
      JUNO_BENCHMARK_REGISTRY: '/private/registry', JUNO_BENCHMARK_WORK_ROOT: '/private/work',
      JUNO_BENCHMARK_SHADOW_KANBAN_EXECUTABLE: '/private/tool',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/source/.git/objects',
      OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret', SSH_AUTH_SOCK: '/agent.sock',
    }, '/candidate');
    expect(clean).toMatchObject({ PATH: '/bin', SAFE_FLAG: 'yes', HOME: '/candidate/.juno_task/home', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    expect(clean).not.toHaveProperty('JUNO_TASK_ROOT');
    expect(clean).not.toHaveProperty('JUNO_BENCHMARK_REGISTRY');
    expect(clean).not.toHaveProperty('JUNO_BENCHMARK_WORK_ROOT');
    expect(clean).not.toHaveProperty('JUNO_BENCHMARK_SHADOW_KANBAN_EXECUTABLE');
    expect(clean).not.toHaveProperty('GIT_ALTERNATE_OBJECT_DIRECTORIES');
    expect(clean).not.toHaveProperty('OPENAI_API_KEY');
    expect(clean).not.toHaveProperty('GITHUB_TOKEN');
    expect(clean).not.toHaveProperty('SSH_AUTH_SOCK');
  });
});
