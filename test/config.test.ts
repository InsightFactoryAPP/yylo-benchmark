import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

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
