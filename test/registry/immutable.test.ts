import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';

async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-registry-')); return { root, registry: new ImmutableArtifactRegistry(root) }; }

describe('private immutable artifact registry', () => {
  it('stores write-once SHA-256 objects privately and verifies reads', async () => {
    const { root, registry } = await fixture();
    const first = await registry.put('stdout', 'secret evidence'); const second = await registry.put('stdout', 'secret evidence');
    expect(first).toEqual(second); expect((await registry.read(first)).toString()).toBe('secret evidence');
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, first.path))).mode & 0o777).toBe(0o400);
  });

  it('detects content tampering and public permissions', async () => {
    const { root, registry } = await fixture(); const reference = await registry.put('patch', 'original');
    await chmod(path.join(root, reference.path), 0o600); await writeFile(path.join(root, reference.path), 'tampered');
    await expect(registry.read(reference)).rejects.toThrow(/verification failed/u);
    const other = await registry.put('grader', 'private'); await chmod(path.join(root, other.path), 0o644);
    await expect(registry.read(other)).rejects.toThrow(/permissions are not private/u);
  });

  it('maintains a verified append-only chain and fails closed on concurrent writers', async () => {
    const { root, registry } = await fixture(); const object = await registry.put('result', '{}');
    await registry.append('EXP1', object, '2026-08-12T00:00:00Z');
    expect(await registry.verifyExperiment('EXP1')).toHaveLength(1);
    await expect(registry.append('EXP1', object)).rejects.toThrow(/already recorded/u);
    await mkdir(path.join(root, '.locks', 'experiment-EXP2'));
    await expect(registry.append('EXP2', object)).rejects.toThrow(/concurrent registry writer/u);
  });

  it('recovers the last atomic manifest and detects an interrupted/tampered replacement', async () => {
    const { root, registry } = await fixture(); const object = await registry.put('result', '{}');
    await registry.append('EXP3', object, '2026-08-12T00:00:00Z');
    await writeFile(path.join(root, '.tmp', 'interrupted'), '{');
    expect(await registry.verifyExperiment('EXP3')).toHaveLength(1);
    const manifest = path.join(root, 'experiments', 'EXP3', 'manifest.json');
    const value = JSON.parse(await readFile(manifest, 'utf8')) as { entries: Array<{ role: string }> }; value.entries[0]!.role = 'changed'; await writeFile(manifest, JSON.stringify(value));
    await expect(registry.verifyExperiment('EXP3')).rejects.toThrow(/append chain is invalid/u);
  });

  it('writes compact case indexes once per experiment', async () => {
    const { root, registry } = await fixture(); await registry.writeCaseIndex('CASE1', 'EXP1', { task_id: 'K1', evidence: ['sha256:x'] });
    const index = await readFile(path.join(root, 'cases', 'CASE1', 'index.json'), 'utf8');
    expect(index).not.toContain('large evidence');
    await expect(registry.writeCaseIndex('CASE1', 'EXP1', {})).rejects.toThrow(/already contains/u);
  });
});
