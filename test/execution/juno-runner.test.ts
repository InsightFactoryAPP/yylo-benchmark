import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createJunoRunner, runExperiment } from '../../src/execution/index.js';
import { PersistentTypedResourceLocks } from '../../src/execution/resource-lock.js';
import type { AttemptV1 } from '../../src/contracts/schemas.js';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { PublicKanbanClient } from '../../src/kanban/client.js';
import { planExperiment } from '../../src/planning/index.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { installFakeKanban, optedInTask } from '../kanban/fake-cli.js';

const hash = `sha256:${'1'.repeat(64)}` as const;
const exec = promisify(execFile);
function attempt(version: string): AttemptV1 {
  return {
    schema_version: 'juno_benchmark_attempt.v1', attempt_id: 'A1', experiment_id: hash,
    case_input_hash: hash, snapshot_hash: hash, prompt_hash: hash, agent: 'yylo',
    provider: 'openai', model: 'openai/gpt-mini', tool_policy_hash: hash, budget_hash: hash,
    package_version: '0.1.0', juno_version: version, session_topology: 'fresh',
  };
}
function invocation(version: string, root: string) {
  const selected = attempt(version);
  const grant = { schema_version: 'juno_benchmark_task_authorization.v1' as const, plan_id: hash, authorization_id: 'fixture',
    models: [selected.model], expires_at: '2099-01-01T00:00:00.000Z', currency: 'USD' as const, aggregate_max_usd: 20, per_attempt_max_usd: 20 };
  return { attempt: selected, repository: root, prompt: 'fixture', environment: process.env, timeoutMs: 5_000,
    spendAuthorization: { schema_version: 'juno_benchmark_task_spend_dispatch.v1' as const, authorization_hash: canonicalHash(grant),
      plan_id: hash, authorization_id: 'fixture', model: selected.model, provider: selected.provider, attempt: 1,
      currency: 'USD' as const, attempt_max_usd: 20, aggregate_max_usd: 20, reserved_before_usd: 0,
      remaining_before_usd: 20, expires_at: '2099-01-01T00:00:00.000Z', grant } };
}

async function fakeJuno(versionDelayMs = 0): Promise<{ root: string; executable: string; dispatchMarker: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-juno-runner-'));
  const executable = path.join(root, 'fake-juno.mjs');
  const dispatchMarker = path.join(root, 'candidate-dispatched');
  await writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv[2] === '--version') { setTimeout(() => console.log('2.1.2'), ${versionDelayMs}); }
else {
fs.writeFileSync(${JSON.stringify(dispatchMarker)}, 'dispatched');
console.log(JSON.stringify({schema_version:'juno_execution_envelope.v1',status:'success',session_id:'S1',provider:'openai',model:'gpt-mini',juno_version:'2.1.2',cost:{completeness:'complete',usd:0}}));
}
`);
  await chmod(executable, 0o700);
  return { root, executable, dispatchMarker };
}

async function taskPlanFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-task-plan-lock-'));
  const fake = await installFakeKanban(root, { tasks: { CASE1: optedInTask() }, revisions: { CASE1: '1'.repeat(64) } });
  const client = new PublicKanbanClient(fake.loaded); const repository = path.join(root, 'candidate'); await mkdir(repository);
  await exec('git', ['init', '-q'], { cwd: repository }); await exec('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
  await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository }); await writeFile(path.join(repository, 'file.txt'), 'before\n');
  await exec('git', ['add', '.'], { cwd: repository }); await exec('git', ['commit', '-qm', 'base'], { cwd: repository });
  const baselineCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  const baselineTree = (await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository })).stdout.trim();
  const plan = await planExperiment(client, { taskId: 'CASE1', models: ['openai/gpt-mini'], modelSelectors: { 'openai/gpt-mini': ':mini' },
    attempts: 1, snapshotHash: hash, wikiHashes: {}, toolPolicyHash: hash, budgetHash: hash, packageVersion: '0.1.0', junoVersion: '2.0.0' });
  return { root, client, repository, baselineCommit, baselineTree, plan, registry: new ImmutableArtifactRegistry(path.join(root, 'registry')) };
}

describe('canonical Juno process runner', () => {
  it('rejects missing, expired, or model-mismatched spend grants before probing the paid executable', async () => {
    const fake = await fakeJuno(); const runner = createJunoRunner({ executable: fake.executable });
    const valid = invocation('2.1.2', fake.root);
    const { spendAuthorization: _omitted, ...missing } = valid;
    await expect(runner(missing)).rejects.toThrow(/spend authorization/u);
    await expect(runner({ ...valid, spendAuthorization: { ...valid.spendAuthorization, expires_at: '2020-01-01T00:00:00.000Z' } }))
      .rejects.toThrow(/spend authorization/u);
    const expiredGrant = { ...valid.spendAuthorization.grant, expires_at: '2020-01-01T00:00:00.000Z' };
    await expect(runner({ ...valid, spendAuthorization: { ...valid.spendAuthorization,
      authorization_hash: canonicalHash(expiredGrant), grant: expiredGrant } })).rejects.toThrow(/spend authorization/u);
    await expect(runner({ ...valid, spendAuthorization: { ...valid.spendAuthorization, model: 'openai/other' } }))
      .rejects.toThrow(/spend authorization/u);
    const splitIdentity = invocation('2.1.2', fake.root); const mismatchedAttempt = { ...splitIdentity.attempt, model: 'zai/gpt-mini' };
    const mismatchedGrant = { ...splitIdentity.spendAuthorization.grant, models: [mismatchedAttempt.model] };
    await expect(runner({ ...splitIdentity, attempt: mismatchedAttempt, spendAuthorization: { ...splitIdentity.spendAuthorization,
      model: mismatchedAttempt.model, authorization_hash: canonicalHash(mismatchedGrant), grant: mismatchedGrant } }))
      .rejects.toThrow(/spend authorization/u);
  });

  it('revalidates expiry after the version probe and never starts an expired paid dispatch', async () => {
    const fake = await fakeJuno(500); const valid = invocation('2.1.2', fake.root);
    const expiresAt = new Date(Date.now() + 200).toISOString(); const grant = { ...valid.spendAuthorization.grant, expires_at: expiresAt };
    await expect(createJunoRunner({ executable: fake.executable })({ ...valid, spendAuthorization: { ...valid.spendAuthorization,
      expires_at: expiresAt, authorization_hash: canonicalHash(grant), grant } })).rejects.toThrow(/spend authorization/u);
    await expect(access(fake.dispatchMarker)).rejects.toThrow();
  });

  it('probes and binds the exact executable version before candidate dispatch', async () => {
    const fake = await fakeJuno();
    const evidence = await createJunoRunner({ executable: fake.executable })({
      ...invocation('2.1.2', fake.root) });
    expect(evidence).toMatchObject({ observedJunoVersion: '2.1.2', exitCode: 0 });
    expect(evidence.stdout).toContain('juno_execution_envelope.v1');
  });

  it('refuses version drift before running the paid candidate command', async () => {
    const fake = await fakeJuno();
    await expect(createJunoRunner({ executable: fake.executable })({
      ...invocation('2.1.1', fake.root) })).rejects.toThrow(/version mismatch/u);
  });

  it('serializes concurrent same-plan admission before the durable dispatch marker', async () => {
    const item = await taskPlanFixture(); let calls = 0; const lockRoot = path.join(item.root, 'task-plan-locks');
    const base = { client: item.client, registry: item.registry, plan: item.plan,
      prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: hash,
        baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
      runner: async (input: Parameters<Parameters<typeof runExperiment>[0]['runner']>[0]) => { calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: '2.0.0',
          startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000,
          exitCode: 1, signal: null, stdout: JSON.stringify({ terminal_class: 'model_failure', model: input.attempt.model,
            juno_version: '2.0.0', total_cost_usd: 0 }), stderr: '', patchHash: null }; } };
    const [first, second] = await Promise.all([
      runExperiment({ ...base, locks: new PersistentTypedResourceLocks({ root: lockRoot }) }),
      runExperiment({ ...base, locks: new PersistentTypedResourceLocks({ root: lockRoot }) }),
    ]);
    expect(calls).toBe(1);
    expect([first, second].filter((outcome) => outcome.attempts[0]?.recovered)).toHaveLength(1);
    expect((await item.registry.verifyExperiment(item.plan.plan_id.slice(7))).filter((entry) => entry.role === 'attempt-dispatched')).toHaveLength(1);
  });
});
