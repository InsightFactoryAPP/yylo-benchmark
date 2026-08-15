import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJunoRunner } from '../../src/execution/index.js';
import type { AttemptV1 } from '../../src/contracts/schemas.js';

const hash = `sha256:${'1'.repeat(64)}` as const;
function attempt(version: string): AttemptV1 {
  return {
    schema_version: 'juno_benchmark_attempt.v1', attempt_id: 'A1', experiment_id: 'E1',
    case_input_hash: hash, snapshot_hash: hash, prompt_hash: hash, agent: 'juno-code',
    provider: 'openai', model: 'openai/gpt-mini', tool_policy_hash: hash, budget_hash: hash,
    package_version: '0.1.0', juno_version: version, session_topology: 'fresh',
  };
}

async function fakeJuno(): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-juno-runner-'));
  const executable = path.join(root, 'fake-juno.mjs');
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('2.1.2'); process.exit(0); }
console.log(JSON.stringify({schema_version:'juno_execution_envelope.v1',status:'success',session_id:'S1',provider:'openai',model:'gpt-mini',juno_version:'2.1.2',cost:{completeness:'complete',usd:0}}));
`);
  await chmod(executable, 0o700);
  return { root, executable };
}

describe('canonical Juno process runner', () => {
  it('probes and binds the exact executable version before candidate dispatch', async () => {
    const fake = await fakeJuno();
    const evidence = await createJunoRunner({ executable: fake.executable })({
      attempt: attempt('2.1.2'), repository: fake.root, prompt: 'fixture', environment: process.env, timeoutMs: 5_000,
    });
    expect(evidence).toMatchObject({ observedJunoVersion: '2.1.2', exitCode: 0 });
    expect(evidence.stdout).toContain('juno_execution_envelope.v1');
  });

  it('refuses version drift before running the paid candidate command', async () => {
    const fake = await fakeJuno();
    await expect(createJunoRunner({ executable: fake.executable })({
      attempt: attempt('2.1.1'), repository: fake.root, prompt: 'fixture', environment: process.env, timeoutMs: 5_000,
    })).rejects.toThrow(/version mismatch/u);
  });
});
