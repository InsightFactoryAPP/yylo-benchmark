import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

export async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await exec('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  });
  return result.stdout.trim();
}

export async function makeSourceRepository(): Promise<{ root: string; commit: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-source-'));
  await git(root, 'init', '--quiet', '--initial-branch', 'main');
  await git(root, 'config', 'user.name', 'Fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'plain.txt'), Buffer.from([0, 1, 2, 10, 255]));
  await writeFile(path.join(root, 'run.sh'), '#!/bin/sh\necho exact\n');
  await chmod(path.join(root, 'run.sh'), 0o755);
  await symlink('plain.txt', path.join(root, 'plain-link'));
  await mkdir(path.join(root, '.juno_task'), { recursive: true });
  await writeFile(path.join(root, '.juno_task', 'canonical-only.txt'), 'must be excluded');
  await mkdir(path.join(root, 'hidden-reference'), { recursive: true });
  await writeFile(path.join(root, 'hidden-reference', 'solution.patch'), 'future answer');
  await git(root, 'add', '--all');
  await git(root, 'commit', '--quiet', '-m', 'base');
  return { root, commit: await git(root, 'rev-parse', 'HEAD') };
}
