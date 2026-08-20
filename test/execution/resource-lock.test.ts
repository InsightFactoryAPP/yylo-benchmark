import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentTypedResourceLocks } from '../../src/execution/resource-lock.js';

const resource = { type: 'production', id: 'shared' } as const;
const digest = createHash('sha256').update('{"id":"shared","type":"production"}').digest('hex');

async function realProcessOwner(root: string): Promise<{ child: ReturnType<typeof spawn>; ready: Promise<void> }> {
  const script = `
const fs=require('node:fs'), path=require('node:path');
const root=process.argv[1], hash=process.argv[2], lock=path.join(root,hash+'.lock');
fs.mkdirSync(root,{recursive:true,mode:0o700}); fs.mkdirSync(lock,{mode:0o700});
fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({schema_version:'juno_benchmark_resource_lock.v1',resource_hash:'sha256:'+hash,pid:process.pid,host:'fixture',nonce:'0123456789abcdef0123456789abcdef',created_at:new Date().toISOString()}));
process.stdout.write('ready\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script, root, digest], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout!.once('data', () => resolve()); });
  return { child, ready };
}

describe('persistent typed resource locks', () => {
  it('excludes a real second process with bounded owner diagnostics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-lock-')); const owner = await realProcessOwner(root); await owner.ready;
    try {
      const locks = new PersistentTypedResourceLocks({ root, waitTimeoutMs: 80, pollIntervalMs: 10, staleOwnerMs: 0 });
      await expect(locks.acquire([resource])).rejects.toThrow(/timed out.*owner_pid=/u);
    } finally { owner.child.kill('SIGKILL'); await new Promise((resolve) => owner.child.once('close', resolve)); }
  });

  it('reclaims only an old dead owner and preserves typed ordering', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-stale-lock-')); const lock = path.join(root, `${digest}.lock`); await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ schema_version: 'juno_benchmark_resource_lock.v1', resource_hash: `sha256:${digest}`,
      pid: 999_999_999, host: 'dead', nonce: 'abcdefabcdefabcdefabcdefabcdefab', created_at: '2000-01-01T00:00:00.000Z' }));
    const locks = new PersistentTypedResourceLocks({ root, waitTimeoutMs: 100, pollIntervalMs: 5, staleOwnerMs: 1 });
    const acquired = await locks.acquire([resource, resource]); expect(acquired.resources).toEqual([resource]);
    const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')) as { pid: number }; expect(owner.pid).toBe(process.pid);
    await acquired.release();
  });
});
