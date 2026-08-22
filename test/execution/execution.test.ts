import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { runExperiment } from '../../src/execution/index.js';
import { PublicKanbanClient } from '../../src/kanban/client.js';
import { planExperiment } from '../../src/planning/index.js';
import { ImmutableArtifactRegistry } from '../../src/registry/index.js';
import { installFakeKanban, optedInTask, type FakeState } from '../kanban/fake-cli.js';

const exec = promisify(execFile); const h = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-execution-')); const revision = '1'.repeat(64);
  const fake = await installFakeKanban(root, { tasks: { CASE1: optedInTask() }, revisions: { CASE1: revision } });
  const client = new PublicKanbanClient(fake.loaded); const repository = path.join(root, 'candidate'); await mkdir(repository);
  await exec('git', ['init', '-q'], { cwd: repository }); await exec('git', ['config', 'user.name', 'Fixture'], { cwd: repository }); await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
  await writeFile(path.join(repository, 'file.txt'), 'before\n'); await exec('git', ['add', '.'], { cwd: repository }); await exec('git', ['commit', '-qm', 'base'], { cwd: repository });
  const baselineCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  const baselineTree = (await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository })).stdout.trim();
  const plan = await planExperiment(client, { taskId: 'CASE1', models: ['openai/gpt-mini'], modelSelectors: { 'openai/gpt-mini': ':mini' }, attempts: 1, snapshotHash: h('2'), wikiHashes: {}, toolPolicyHash: h('3'), budgetHash: h('4'), packageVersion: '0.1.0', junoVersion: '2.0.0' });
  return { root, fake, client, repository, baselineCommit, baselineTree, plan, registry: new ImmutableArtifactRegistry(path.join(root, 'registry')) };
}

describe('recoverable immutable execution', () => {
  it('executes one candidate, binds patch/session/cost, and updates compact Kanban truth', async () => {
    const item = await fixture(); let calls = 0;
    vi.stubEnv('YYLO_BENCHMARK_REGISTRY', '/private/registry');
    vi.stubEnv('YYLO_BENCHMARK_WORK_ROOT', '/private/work');
    let outcome: Awaited<ReturnType<typeof runExperiment>>;
    try {
      outcome = await runExperiment({ client: item.client, registry: item.registry, plan: item.plan,
        prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
        runner: async (input) => { calls += 1; expect(input.environment).not.toHaveProperty('YYLO_BENCHMARK_REGISTRY'); expect(input.environment).not.toHaveProperty('YYLO_BENCHMARK_WORK_ROOT'); await writeFile(path.join(input.repository, 'file.txt'), 'after\n'); await writeFile(path.join(input.repository, 'new.txt'), 'new\n'); return { attemptId: input.attempt.attempt_id, expectedModel: 'openai/gpt-mini', expectedJunoVersion: '2.0.0', observedJunoVersion: '2.0.0', startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:02.000Z', elapsedMs: 2000, exitCode: 0, signal: null, stdout: JSON.stringify({ schema_version: 'juno_execution_envelope.v1', status: 'success', session_id: 'SESSION1', model: 'gpt-mini', provider: 'openai', juno_version: '2.0.0', cost: { completeness: 'complete', usd: 0 } }), stderr: '', patchHash: null }; },
        grader: async () => ({ graderId: 'fixture-grader', graderVersion: '1', passed: true, output: { passed: true } }) });
    } finally { vi.unstubAllEnvs(); }
    expect(calls).toBe(1); expect(outcome.attempts[0]?.result).toMatchObject({ terminal_class: 'resolved', session_id: 'SESSION1', cost: { completeness: 'complete', usd: 0 } });
    const patchEntry = (await item.registry.verifyExperiment(item.plan.plan_id.slice(7))).find((entry) => entry.role === 'patch')!;
    expect((await item.registry.read(patchEntry)).toString()).toContain('new.txt');
    const state = JSON.parse(await readFile(item.fake.statePath, 'utf8')) as FakeState; const record = state.tasks[state.records![0]!]! as { fields: { benchmark: { status: string; attempts: unknown[]; evidence: unknown[] } } };
    expect(record.fields.benchmark).toMatchObject({ status: 'terminal' }); expect(record.fields.benchmark.attempts).toHaveLength(1); expect(record.fields.benchmark.evidence.length).toBeGreaterThan(5);
  });

  it('captures ignored and unstaged paths independently of candidate index metadata', async () => {
    const item = await fixture();
    await runExperiment({ client: item.client, registry: item.registry, plan: item.plan,
      prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
      runner: async (input) => {
        await mkdir(path.join(input.repository, '.git', 'info'), { recursive: true });
        await writeFile(path.join(input.repository, '.git', 'info', 'exclude'), 'hidden.txt\n');
        await writeFile(path.join(input.repository, 'hidden.txt'), 'must be retained\n');
        await writeFile(path.join(input.repository, 'staged.txt'), 'candidate index state\n');
        await exec('git', ['add', 'staged.txt'], { cwd: input.repository });
        return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: '2.0.0', startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000, exitCode: 0, signal: null, stdout: JSON.stringify({ resolved: true, model: input.attempt.model, juno_version: '2.0.0' }), stderr: '', patchHash: null };
      } });
    const patchEntry = (await item.registry.verifyExperiment(item.plan.plan_id.slice(7))).find((entry) => entry.role === 'patch')!;
    const patch = (await item.registry.read(patchEntry)).toString();
    expect(patch).toContain('hidden.txt'); expect(patch).toContain('staged.txt');
  });

  it('excludes shadow, controller, HOME/XDG and cache bytes while reproducing product edits exactly', async () => {
    async function capture(shadowByte: string) {
      const item = await fixture();
      await runExperiment({ client: item.client, registry: item.registry, plan: item.plan,
        prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
        runner: async (input) => {
          await mkdir(path.join(input.repository, '.juno_task', 'home', '.cache'), { recursive: true });
          await mkdir(path.join(input.repository, '.juno_task', 'cache'), { recursive: true });
          await writeFile(path.join(input.repository, '.juno_task', 'controller-route'), `controller-${shadowByte}\n`);
          await writeFile(path.join(input.repository, '.juno_task', 'home', '.cache', 'candidate-cache'), `home-${shadowByte}\n`);
          await writeFile(path.join(input.repository, '.juno_task', 'cache', 'shadow-state'), `shadow-${shadowByte}\n`);
          await writeFile(path.join(input.repository, 'file.txt'), 'product-after\n');
          await writeFile(path.join(input.repository, 'product.txt'), 'exact-product-bytes\n');
          return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: '2.0.0', startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000, exitCode: 0, signal: null, stdout: JSON.stringify({ resolved: true, model: input.attempt.model, juno_version: '2.0.0' }), stderr: '', patchHash: null };
        }, grader: async () => ({ graderId: 'fixture-grader', graderVersion: '1', passed: true, output: { passed: true } }) });
      const entries = await item.registry.verifyExperiment(item.plan.plan_id.slice(7));
      const patchEntry = entries.find((entry) => entry.role === 'patch')!;
      const graderInput = entries.find((entry) => entry.role === 'grader-input')!;
      const patch = await item.registry.read(patchEntry);
      const reproduced = path.join(item.root, 'reproduced');
      await exec('git', ['clone', '-q', item.repository, reproduced]);
      await new Promise<void>((resolve, reject) => {
        const child = execFile('git', ['apply', '--binary', '-'], { cwd: reproduced }, (error) => error === null ? resolve() : reject(error));
        child.stdin?.end(patch);
      });
      expect(await readFile(path.join(reproduced, 'file.txt'), 'utf8')).toBe('product-after\n');
      expect(await readFile(path.join(reproduced, 'product.txt'), 'utf8')).toBe('exact-product-bytes\n');
      return { patch, patchHash: patchEntry.sha256, graderInputHash: graderInput.sha256 };
    }
    const first = await capture('alpha'); const second = await capture('beta');
    expect(first.patch).toEqual(second.patch);
    expect(first.patchHash).toBe(second.patchHash);
    expect(first.graderInputHash).toBe(second.graderInputHash);
    expect(first.patch.toString('utf8')).not.toMatch(/\.juno_task|controller-alpha|home-alpha|shadow-alpha/u);
  });

  it('captures raw bytes independently of candidate clean filters', async () => {
    const item = await fixture();
    await runExperiment({ client: item.client, registry: item.registry, plan: item.plan,
      prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
      runner: async (input) => {
        await writeFile(path.join(input.repository, '.gitattributes'), '*.txt filter=erase\n');
        await exec('git', ['config', 'filter.erase.clean', 'printf filtered'], { cwd: input.repository });
        await writeFile(path.join(input.repository, 'file.txt'), 'raw final bytes\n');
        return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: '2.0.0', startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000, exitCode: 0, signal: null, stdout: JSON.stringify({ resolved: true, model: input.attempt.model, juno_version: '2.0.0' }), stderr: '', patchHash: null };
      } });
    const patchEntry = (await item.registry.verifyExperiment(item.plan.plan_id.slice(7))).find((entry) => entry.role === 'patch')!;
    expect((await item.registry.read(patchEntry)).toString()).toContain('raw final bytes');
  });

  it('rejects nested repository metadata before patch capture', async () => {
    const item = await fixture();
    await expect(runExperiment({ client: item.client, registry: item.registry, plan: item.plan,
      prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
      runner: async (input) => {
        await mkdir(path.join(input.repository, 'nested', '.git'), { recursive: true });
        return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: '2.0.0', startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000, exitCode: 0, signal: null, stdout: JSON.stringify({ resolved: true, model: input.attempt.model, juno_version: '2.0.0' }), stderr: '', patchHash: null };
      } })).rejects.toThrow(/nested repository metadata/u);
  });

  it('rejects a candidate that moves the manifest-bound synthetic baseline', async () => {
    const item = await fixture();
    await expect(runExperiment({ client: item.client, registry: item.registry, plan: item.plan,
      prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
      runner: async (input) => {
        await writeFile(path.join(input.repository, 'file.txt'), 'committed mutation\n');
        await exec('git', ['add', 'file.txt'], { cwd: input.repository }); await exec('git', ['commit', '-qm', 'tamper'], { cwd: input.repository });
        return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: '2.0.0', startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000, exitCode: 0, signal: null, stdout: JSON.stringify({ resolved: true, model: input.attempt.model, juno_version: '2.0.0' }), stderr: '', patchHash: null };
      } })).rejects.toThrow(/mutated the manifest-bound synthetic Git baseline/u);
  });

  it('does not rerun a durable terminal paid attempt', async () => {
    const item = await fixture(); let calls = 0; const options = { client: item.client, registry: item.registry, plan: item.plan,
      prepareAttempt: async () => ({ repository: item.repository, snapshotHash: item.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: item.baselineCommit, baselineTree: item.baselineTree }),
      runner: async (input: Parameters<Parameters<typeof runExperiment>[0]['runner']>[0]) => { calls += 1; return { attemptId: input.attempt.attempt_id, expectedModel: 'openai/gpt-mini', expectedJunoVersion: '2.0.0', startedAt: '2026-08-12T00:00:00.000Z', endedAt: '2026-08-12T00:00:01.000Z', elapsedMs: 1000, exitCode: 1, signal: null, stdout: JSON.stringify({ terminal_class: 'model_failure', model: 'openai/gpt-mini', juno_version: '2.0.0', total_cost_usd: 2 }), stderr: '', patchHash: null }; } };
    await runExperiment(options); const recovered = await runExperiment(options);
    expect(recovered.attempts[0]?.recovered).toBe(true); expect(calls).toBe(1);
  });
});
