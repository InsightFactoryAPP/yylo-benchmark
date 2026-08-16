import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, resolveKanbanCommand } from '../src/config/index.js';

describe('configuration', () => {
  it('finds and validates a versioned project config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-config-'));
    const child = path.join(root, 'nested');
    await mkdir(child);
    await writeFile(path.join(root, 'juno-benchmark.config.json'), JSON.stringify({
      schema_version: 'juno_benchmark_config.v1', repository_id: 'fixture', kanban: { arguments: [] },
      model_aliases: { ':mini': 'openai/gpt-mini' },
    }));
    const loaded = await loadConfig({ cwd: child });
    expect(loaded.projectRoot).toBe(root);
    expect(loaded.config.repository_id).toBe('fixture');
    expect(loaded.config.model_aliases).toEqual({ ':mini': 'openai/gpt-mini' });
  });

  it('discovers the project-local public Kanban wrapper without a config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-project-'));
    const child = path.join(root, 'package', 'nested');
    await mkdir(path.join(root, '.juno_task', 'scripts'), { recursive: true });
    await mkdir(child, { recursive: true });
    await writeFile(path.join(root, '.juno_task', 'scripts', 'kanban.sh'), 'fixture');
    expect((await loadConfig({ cwd: child })).projectRoot).toBe(root);
  });

  it('prefers the exact registered metadata controller over a retired local wrapper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-registered-'));
    const controller = `${root}-controller`;
    await mkdir(path.join(root, '.juno_task', 'scripts'), { recursive: true });
    await writeFile(path.join(root, '.juno_task', 'scripts', 'kanban.sh'), 'retired');
    execFileSync('git', ['init', '-b', 'product'], { cwd: root, stdio: 'ignore' });
    await mkdir(path.join(controller, '.juno_task', 'scripts'), { recursive: true });
    await mkdir(path.join(controller, '.juno_task', 'config'), { recursive: true });
    await writeFile(path.join(controller, '.juno_task', 'scripts', 'kanban.sh'), 'registered');
    await writeFile(path.join(controller, '.juno_task', 'config', 'metadata-controller.json'), '{}');
    execFileSync('git', ['init', '-b', 'metadata'], { cwd: controller, stdio: 'ignore' });
    execFileSync('git', ['config', 'juno.controller.path', controller], { cwd: root });
    execFileSync('git', ['config', 'juno.controller.branch', 'metadata'], { cwd: root });
    const loaded = await loadConfig({ cwd: root });
    await expect(resolveKanbanCommand(loaded)).resolves.toEqual({
      executable: path.join(await realpath(controller), '.juno_task', 'scripts', 'kanban.sh'), arguments: [],
    });
  });

  it('rejects aliases that do not bind an exact provider/model identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-config-alias-'));
    await writeFile(path.join(root, 'juno-benchmark.config.json'), JSON.stringify({
      schema_version: 'juno_benchmark_config.v1', repository_id: 'root', model_aliases: { ':mini': ':other' },
    }));
    await expect(loadConfig({ cwd: root })).rejects.toThrow(/exact provider\/model/u);
  });

  it('rejects unknown policy keys', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-config-bad-'));
    await writeFile(path.join(root, 'juno-benchmark.config.json'), JSON.stringify({
      schema_version: 'juno_benchmark_config.v1', repository_id: 'root', kanban: { arguments: [] }, surprise: true,
    }));
    await expect(loadConfig({ cwd: root })).rejects.toThrow();
  });
});
