import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { git } from '../snapshot/real-git.js';
import { deriveCandidateManifest } from '../../src/snapshot/index.js';

async function phase3() {
  return import('../../src/v2/adapters.js').catch(() => null);
}

async function sourceRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-v2-adapter-source-'));
  await git(root, 'init', '--quiet', '--initial-branch', 'main');
  await git(root, 'config', 'user.name', 'Fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(path.join(root, 'workflows'));
  const workflow = `name: formerly-forbidden\nworking_directory: nested\nenvironment:\n  SAFE: value\nsteps:\n  - id: arbitrary\n    cwd: nested\n    env: { LOCAL: yes }\n    executable: node\n    argv: [node, script.mjs]\n  - id: managed\n    managed_agent: { prompt: do-work }\nconfiguration:\n  candidate: "{{ candidate_model }}"\n`;
  await writeFile(path.join(root, 'workflows', 'flexible.yaml'), workflow);
  await writeFile(path.join(root, 'task.txt'), 'repair the fixture');
  await git(root, 'add', '--all');
  await git(root, 'commit', '--quiet', '-m', 'fixture');
  const commit = await git(root, 'rev-parse', 'HEAD');
  const manifest = await deriveCandidateManifest({ sourceRepository: root, baseCommit: commit,
    excludedPaths: ['.juno_task', 'hidden-graders', 'reference-solutions'] });
  return { root, commit, workflow, candidateManifestHash: manifest.manifest_hash };
}

const evaluator = { profile_id: 'shared', profile_version: '1', generation: 1, kind: 'deterministic' as const, required: true, config_hash: `sha256:${'a'.repeat(64)}` };

function successfulTerminal(selector: string) {
  return {
    status: 'success' as const, exit_code: 0, signal: null, session_id: 'session-1',
    resolved_provider: 'arbitrary-provider', resolved_model: selector,
    observed_provider: 'arbitrary-provider', observed_model: selector, harness_version: 'fake-1',
    started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z', runtime_ms: 1000,
    cost: { completeness: 'not_applicable' as const, usd: null }, process: { pid: 1, command: ['fake'] }, artifacts: [], raw_output: 'candidate verified output',
  };
}

describe('uUcc9l phase 3 unified task and Workflow Runner adapters', () => {
  it('P3-A1 compiles task and workflow cases into the same AttemptPlan and AttemptEvidence contracts', async () => {
    const api = await phase3();
    expect(api, 'v2 task/workflow adapter module must exist').not.toBeNull();
    const source = await sourceRepository();
    const common = { sourceRepository: source.root, baseCommit: source.commit, sourceIdentity: { repository: source.root, commit: source.commit, tree: await git(source.root, 'rev-parse', 'HEAD^{tree}'), candidate_manifest_hash: source.candidateManifestHash }, experimentId: 'exp', attemptIndex: 1, harnessProfile: 'fake', requestedModel: 'provider/model', evaluators: [evaluator], yyloVersion: '2', benchmarkVersion: '2' };
    const task = await api!.compileTaskAttempt({ ...common, taskId: 'task-1', taskVersion: '1', prompt: 'repair' });
    const workflow = await api!.compileWorkflowAttempt({ ...common, workflowId: 'flow-1', workflowVersion: '1', workflowPath: 'workflows/flexible.yaml', variables: { candidate_model: 'provider/model' }, controlledModelVariable: 'candidate_model' });
    expect(task.schema_version).toBe(workflow.schema_version);
    expect(Object.keys(task).sort()).toEqual(Object.keys(workflow).sort());

    const run = async (plan: typeof task, suffix: string) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `phase3-${suffix}-`));
      const adapter = { profileId: 'fake', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run: async () => successfulTerminal(plan.requested_model), reconcile: async () => ({ state: 'ambiguous' as const, reason: 'unknown' }) };
      return api!.executeCaseAttempt({ plan, sourceRepository: source.root, attemptsRoot: path.join(root, 'attempts'), privateRegistryRoot: path.join(root, 'registry'), intentRoot: path.join(root, 'intents'), adapter });
    };
    const taskResult = await run(task, 'task');
    const workflowResult = await run(workflow, 'workflow');
    expect(taskResult.evidence.schema_version).toBe(workflowResult.evidence.schema_version);
    expect(Object.keys(taskResult.evidence).sort()).toEqual(Object.keys(workflowResult.evidence).sort());
    expect(taskResult.evidence.candidate.output).toBe('candidate verified output');
  });

  it('P3-A2 passes formerly forbidden Workflow Runner YAML through byte-for-byte without admission or rewriting', async () => {
    const api = await phase3();
    expect(api, 'v2 task/workflow adapter module must exist').not.toBeNull();
    const source = await sourceRepository();
    const tree = await git(source.root, 'rev-parse', 'HEAD^{tree}');
    const plan = await api!.compileWorkflowAttempt({ sourceRepository: source.root, baseCommit: source.commit, sourceIdentity: { repository: source.root, commit: source.commit, tree, candidate_manifest_hash: source.candidateManifestHash }, experimentId: 'flow-exp', attemptIndex: 1, harnessProfile: 'workflow-runner', requestedModel: 'provider/model', evaluators: [evaluator], yyloVersion: '2', benchmarkVersion: '2', workflowId: 'flow', workflowVersion: '1', workflowPath: 'workflows/flexible.yaml', variables: { candidate_model: 'provider/model' }, controlledModelVariable: 'candidate_model' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'phase3-flow-run-'));
    let observed: { cwd: string; bytes: string; invocation: unknown } | undefined;
    const adapter = { profileId: 'workflow-runner', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run: async (request: { cwd: string; invocation?: unknown }) => { observed = { cwd: request.cwd, bytes: await readFile(path.join(request.cwd, 'workflows/flexible.yaml'), 'utf8'), invocation: request.invocation }; return successfulTerminal('provider/model'); }, reconcile: async () => ({ state: 'ambiguous' as const, reason: 'unknown' }) };
    const result = await api!.executeCaseAttempt({ plan, sourceRepository: source.root, attemptsRoot: path.join(root, 'attempts'), privateRegistryRoot: path.join(root, 'registry'), intentRoot: path.join(root, 'intents'), adapter });
    expect(observed!.bytes).toBe(source.workflow);
    expect(observed!.cwd).toBe(result.workspace.repository);
    expect(observed!.invocation).toMatchObject({ kind: 'workflow', workflow_path: 'workflows/flexible.yaml', variables: { candidate_model: 'provider/model' } });
    expect(observed!.bytes).toContain('managed_agent');
    expect(observed!.bytes).toContain('executable: node');
  });

  it('P3-A3 keeps each complete workflow cwd inside its own workspace and exposes no sibling output', async () => {
    const api = await phase3();
    expect(api, 'v2 task/workflow adapter module must exist').not.toBeNull();
    const source = await sourceRepository();
    const tree = await git(source.root, 'rev-parse', 'HEAD^{tree}');
    const common = { sourceRepository: source.root, baseCommit: source.commit, sourceIdentity: { repository: source.root, commit: source.commit, tree, candidate_manifest_hash: source.candidateManifestHash }, experimentId: 'flow-exp', harnessProfile: 'fake', requestedModel: 'provider/model', evaluators: [evaluator], yyloVersion: '2', benchmarkVersion: '2', workflowId: 'flow', workflowVersion: '1', workflowPath: 'workflows/flexible.yaml', variables: {}, controlledModelVariable: undefined };
    const root = await mkdtemp(path.join(os.tmpdir(), 'phase3-siblings-'));
    const seen: string[] = [];
    const adapter = { profileId: 'fake', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run: async (request: { cwd: string }) => { seen.push(request.cwd); await writeFile(path.join(request.cwd, 'candidate-output'), request.cwd); return successfulTerminal('provider/model'); }, reconcile: async () => ({ state: 'ambiguous' as const, reason: 'unknown' }) };
    for (const attemptIndex of [1, 2]) {
      const plan = await api!.compileWorkflowAttempt({ ...common, attemptIndex });
      await api!.executeCaseAttempt({ plan, sourceRepository: source.root, attemptsRoot: path.join(root, 'attempts'), privateRegistryRoot: path.join(root, 'registry'), intentRoot: path.join(root, 'intents'), adapter });
    }
    expect(seen[0]).not.toBe(seen[1]);
    expect(path.dirname(path.dirname(seen[0]!))).toBe(path.dirname(path.dirname(seen[1]!)));
  });

  it('P3-A4 binds model-variable matrices with identical non-model input and classifies model-only versus agent-system', async () => {
    const api = await phase3();
    expect(api, 'v2 task/workflow adapter module must exist').not.toBeNull();
    const source = await sourceRepository();
    const common = { sourceRepository: source.root, baseCommit: source.commit, sourceIdentity: { repository: source.root, commit: source.commit, tree: await git(source.root, 'rev-parse', 'HEAD^{tree}'), candidate_manifest_hash: `sha256:${'e'.repeat(64)}` }, experimentId: 'matrix', attemptIndex: 1, harnessProfile: 'fake', evaluators: [evaluator], yyloVersion: '2', benchmarkVersion: '2', workflowId: 'flow', workflowVersion: '1', workflowPath: 'workflows/flexible.yaml' };
    const first = await api!.compileWorkflowAttempt({ ...common, requestedModel: 'p/m1', variables: { run_date: 'same', candidate_model: 'p/m1' }, controlledModelVariable: 'candidate_model' });
    const second = await api!.compileWorkflowAttempt({ ...common, requestedModel: 'p/m2', variables: { run_date: 'same', candidate_model: 'p/m2' }, controlledModelVariable: 'candidate_model' });
    expect(first.comparison_kind).toBe('model_only');
    expect(api!.nonModelInputHash(first)).toBe(api!.nonModelInputHash(second));
    const system = await api!.compileWorkflowAttempt({ ...common, requestedModel: 'whole-system-b', variables: { run_date: 'same' } });
    expect(system.comparison_kind).toBe('agent_system');
  });

  it('P3-A5 delegates terminal reuse, supported resume, and ambiguous-effect recovery without duplicate candidate dispatch', async () => {
    const api = await phase3();
    expect(api, 'v2 task/workflow adapter module must exist').not.toBeNull();
    const source = await sourceRepository();
    const plan = await api!.compileTaskAttempt({ sourceRepository: source.root, baseCommit: source.commit, sourceIdentity: { repository: source.root, commit: source.commit, tree: await git(source.root, 'rev-parse', 'HEAD^{tree}'), candidate_manifest_hash: source.candidateManifestHash }, experimentId: 'recover', attemptIndex: 1, harnessProfile: 'fake', requestedModel: 'p/m', evaluators: [evaluator], yyloVersion: '2', benchmarkVersion: '2', taskId: 'task', taskVersion: '1', prompt: 'repair' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'phase3-recover-'));
    const run = vi.fn(async () => successfulTerminal('p/m'));
    const adapter = { profileId: 'fake', version: '1', probe: async () => ({ ready: true as const }), prepare: async () => ({ prepared: true as const }), run, reconcile: async () => ({ state: 'ambiguous' as const, reason: 'manual review' }) };
    const options = { plan, sourceRepository: source.root, attemptsRoot: path.join(root, 'attempts'), privateRegistryRoot: path.join(root, 'registry'), intentRoot: path.join(root, 'intents'), adapter };
    const first = await api!.executeCaseAttempt(options);
    const recovered = await api!.recoverCaseAttempt({ plan, workspace: first.workspace, intentRoot: options.intentRoot, adapter });
    expect(recovered.terminal_hash).toBe(first.terminal.terminal_hash);
    expect(run).toHaveBeenCalledTimes(1);
  }, 60_000);
});
