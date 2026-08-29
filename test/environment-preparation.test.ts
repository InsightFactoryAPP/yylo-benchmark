import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { prepareBenchmarkEnvironment, verifyBenchmarkEnvironment } from '../src/environment/index.js';

const roots: string[] = [];
const originalPath = process.env['PATH'];
const originalVirtualEnv = process.env['VIRTUAL_ENV'];

async function fixture(environment: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-environment-')); roots.push(root);
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  await writeFile(path.join(root, 'yylo-benchmark.config.json'), JSON.stringify({
    schema_version: 'juno_benchmark_config.v1', repository_id: 'environment-fixture', environment,
  }));
  execFileSync('git', ['init', '-b', 'fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', 'yylo-benchmark.config.json'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env['FIXTURE_PROVIDER_TOKEN'];
  if (originalPath === undefined) delete process.env['PATH']; else process.env['PATH'] = originalPath;
  if (originalVirtualEnv === undefined) delete process.env['VIRTUAL_ENV']; else process.env['VIRTUAL_ENV'] = originalVirtualEnv;
});

describe('benchmark environment preparation', () => {
  it('migrates .env.juno without retaining secret values', async () => {
    const root = await fixture({ env_file: '.env.yylo', legacy_env_file: '.env.juno' });
    const secret = 'fixture-never-retain';
    await writeFile(path.join(root, '.env.juno'), `FIXTURE_PROVIDER_TOKEN=${secret}\n`);
    await writeFile(path.join(root, '.juno_task', 'config.json'), JSON.stringify({ envFilePath: '.env.juno', envFileCopied: false }));
    const receipt = await prepareBenchmarkEnvironment(await loadConfig({ cwd: root }));
    expect(receipt).toMatchObject({ schema_version: 'juno_benchmark_environment_preparation.v1',
      env: { canonical: '.env.yylo', legacy: '.env.juno', migrated: true, mode: '0600' },
      repository: { git_worktree: true }, python: null });
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(await readFile(path.join(root, '.env.yylo'), 'utf8')).toBe(`FIXTURE_PROVIDER_TOKEN=${secret}\n`);
    expect((await stat(path.join(root, '.env.yylo'))).mode & 0o777).toBe(0o600);
    await expect(verifyBenchmarkEnvironment(await loadConfig({ cwd: root }))).resolves.toMatchObject({ python: null });
  });

  it('rejects competing canonical and legacy values without exposing them', async () => {
    const root = await fixture({ env_file: '.env.yylo', legacy_env_file: '.env.juno' });
    await writeFile(path.join(root, '.env.yylo'), 'FIXTURE_PROVIDER_TOKEN=canonical\n', { mode: 0o600 });
    await writeFile(path.join(root, '.env.juno'), 'FIXTURE_PROVIDER_TOKEN=legacy\n');
    await expect(prepareBenchmarkEnvironment(await loadConfig({ cwd: root }))).rejects.toThrow(/1 conflicting key/u);
  });

  it('binds the exact prepared interpreter and detects requirement drift', async () => {
    const root = await fixture({ env_file: '.env.yylo', legacy_env_file: '.env.juno', python: {
      venv: '.venv_backend', requirements: ['requirements.txt'], packages: [], imports: [],
    } });
    await writeFile(path.join(root, 'requirements.txt'), 'requests==2.31.0\n');
    const executable = path.join(root, '.venv_backend', 'bin', 'python');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.11.11"; fi\nexit 0\n');
    await chmod(executable, 0o755);
    const receipt = await prepareBenchmarkEnvironment(await loadConfig({ cwd: root }));
    expect(receipt.python).toMatchObject({ venv: '.venv_backend', version: 'Python 3.11.11' });
    expect(process.env['PATH']?.split(path.delimiter)[0]).toBe(path.join(root, '.venv_backend', 'bin'));
    await writeFile(path.join(root, 'requirements.txt'), 'requests==2.32.0\n');
    await expect(verifyBenchmarkEnvironment(await loadConfig({ cwd: root }))).rejects.toThrow(/identity drifted/u);
  });

  it('rejects a deleted submodule worktree before setup can write a boundary', async () => {
    const root = await fixture({ env_file: '.env.yylo', legacy_env_file: '.env.juno' });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},backend`], { cwd: root });
    execFileSync('git', ['commit', '-m', 'add gitlink'], { cwd: root, stdio: 'ignore' });
    await mkdir(path.join(root, 'backend'));
    await writeFile(path.join(root, 'backend', '.git'), 'gitdir: /private/tmp/deleted-benchmark-submodule\n');
    await expect(prepareBenchmarkEnvironment(await loadConfig({ cwd: root }))).rejects.toThrow(/submodule worktrees is unreadable/u);
  });
});
