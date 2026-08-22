import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { canonicalHash, sha256Hex } from '../src/contracts/canonical.js';
import { regradeExperiment, runExperiment } from '../src/execution/index.js';
import { verifyGraderReceiptValue, verifyRequiredGraderReceipt } from '../src/grading/index.js';
import { PublicKanbanClient } from '../src/kanban/client.js';
import { planExperiment } from '../src/planning/index.js';
import { ImmutableArtifactRegistry } from '../src/registry/index.js';
import { createReleaseCaseResult, deriveReleaseCoverageAssertions, deriveReleaseLeakageAssertions, generateReleaseReadinessReceipt, hashReleaseDirectory, REQUIRED_RELEASE_CASE_IDS, REQUIRED_RELEASE_LEAKAGE_IDS, RELEASE_VERIFICATION_COMMANDS, ReleaseReadinessReceiptSchema, type ReleaseCaseId } from '../src/release-readiness/index.js';
import { reconcileJunoTelemetry } from '../src/telemetry/index.js';
import { installFakeKanban, optedInTask } from './kanban/fake-cli.js';

const d = (character: string) => `sha256:${character.repeat(64)}`;
function caseResults(commandHash = canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage)) {
  const observations: Record<string, Record<string, unknown>> = {
    'outcome:success': { candidate_succeeded: true }, 'outcome:failure': { candidate_succeeded: false, terminal_class: 'model_failure' },
    'cost:missing': { completeness: 'unavailable', usd: null }, 'cost:zero': { completeness: 'complete', usd: 0 },
    'cost:positive': { completeness: 'complete', usd: 1 }, 'patch:evidence': { patch_hash: d('a'), retained_bytes_verified: true },
    'grader:valid': { accepted: true, receipt_hash: d('b') }, 'grader:missing': { rejected: true }, 'grader:tampered': { rejected: true },
    'regrade:no-candidate-rerun': { candidate_calls_before: 1, candidate_calls_after: 1, regraded_results: 1 },
  };
  return REQUIRED_RELEASE_CASE_IDS.map((caseId) => createReleaseCaseResult({ caseId, sourceTree: '2'.repeat(40), commandHash,
    observed: caseId.startsWith('model:') ? { model: caseId.slice(6), identity_matched: true } : observations[caseId]! }));
}
function leakageResults(commandHash = canonicalHash(RELEASE_VERIFICATION_COMMANDS.leakage)) {
  return REQUIRED_RELEASE_LEAKAGE_IDS.map((checkId, index) => {
    const detectedClasses = [checkId];
    const output = { synthetic_artifact_hash: d(String((index % 9) + 1)), bytes_scanned: 32 + index, detector: checkId, detected_classes: detectedClasses };
    const stdout_hash = d('8'); const stderr_hash = d('9');
    const log = { stdout_hash, stderr_hash, combined_hash: canonicalHash({ stdout_hash, stderr_hash }) };
    const core = { schema_version: 'juno_benchmark_release_leakage_result.v1' as const, check_id: checkId,
      source_tree: '2'.repeat(40), command_hash: commandHash,
      observed: { detected: true as const, rejected: true as const, detected_classes: detectedClasses },
      output, output_hash: canonicalHash(output), log, log_hash: canonicalHash(log), passed: true as const };
    return { ...core, result_hash: canonicalHash(core) };
  });
}
function input() {
  const cases = caseResults(); const leakChecks = leakageResults();
  const leakBundleCore = { schema_version: 'juno_benchmark_release_leakage_bundle.v1', source_tree: '2'.repeat(40),
    command_hash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.leakage), results: leakChecks, results_hash: canonicalHash(leakChecks) };
  return {
    source: { commit: '1'.repeat(40), tree: '2'.repeat(40), clean: true, packages: [
      { name: '@yylo/benchmark', version: '0.1.0' }, { name: '@yylo/cli', version: '2.1.3-rc.0.21' },
    ] },
    artifacts: [
      ['@yylo/benchmark', 'source', d('1')], ['@yylo/benchmark', 'dist', d('2')], ['@yylo/benchmark', 'npm_tarball', d('3')],
      ['@yylo/cli', 'source', d('4')], ['@yylo/cli', 'dist', d('5')], ['@yylo/cli', 'npm_tarball', d('6')],
    ].map(([packageName, kind, sha256]) => ({ package: packageName, kind, version: packageName === '@yylo/cli' ? '2.1.3-rc.0.21' : '0.1.0', sha256 })),
    cli_identities: ['built', 'installed'].flatMap((installation) => [
      { installation, surface: 'standalone', benchmark_version: '0.1.0', juno_code_version: null },
      { installation, surface: 'delegate', benchmark_version: '0.1.0', juno_code_version: '2.1.3-rc.0.21' },
    ]),
    verification_evidence: ([
      { kind: 'coverage', result: { passed: true, case_results_hash: canonicalHash(cases) }, output: { test_files_passed: 18, tests_passed: 64, coverage_summary_hash: d('7'), case_results: cases, case_results_hash: canonicalHash(cases) } },
      { kind: 'leakage', result: { passed: true, assertions: { checked: [...REQUIRED_RELEASE_LEAKAGE_IDS] } }, output: { files_scanned: 42, bytes_scanned: 4096, canaries_checked: 6, sensitive_environment_values_checked: 3, check_results: leakChecks, check_results_hash: canonicalHash(leakChecks), bundle_hash: canonicalHash(leakBundleCore) } },
    ] as const).map((item) => {
      const result_hash = canonicalHash(item.result);
      const expected = RELEASE_VERIFICATION_COMMANDS[item.kind];
      const command = { ...expected, arguments: [...expected.arguments] };
      const stdout_hash = d('8'); const stderr_hash = d('9');
      const log = { stdout_hash, stderr_hash, combined_hash: canonicalHash({ stdout_hash, stderr_hash }) };
      const evidence = {
        schema_version: 'juno_benchmark_release_verification_evidence.v2', assertion_kind: item.kind,
        source_tree_before: '2'.repeat(40), source_tree_after: '2'.repeat(40), command, command_hash: canonicalHash(command),
        execution: { exit_code: 0, signal: null, timed_out: false }, output: item.output, output_hash: canonicalHash(item.output),
        log, log_hash: canonicalHash(log), result_hash,
      };
      return { kind: item.kind, result: item.result, evidence, result_hash, evidence_hash: canonicalHash(evidence) };
    }),
  };
}

describe('deterministic release-readiness receipt', () => {
  it('binds the exact source, source/dist/tarball artifacts, four CLI surfaces and offline exclusions', () => {
    const first = generateReleaseReadinessReceipt(input()); const second = generateReleaseReadinessReceipt(input());
    expect(second).toEqual(first); expect(ReleaseReadinessReceiptSchema.parse(first)).toEqual(first);
    expect(first.coverage.models).toEqual(['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-mini', 'openai-codex/gpt-5.6-luna', 'zai/glm-5.2']);
    expect(first.exclusions).toContain('frontier-paid-judging');
    const { integrity_hash: integrity, ...core } = first; expect(integrity).toBe(canonicalHash(core));
  });

  it('fails closed on missing identity, version drift, private paths, credentials and candidate HOME/XDG values', () => {
    const missing = input(); missing.artifacts.pop(); expect(() => generateReleaseReadinessReceipt(missing)).toThrow();
    const drift = input(); drift.cli_identities[1]!.benchmark_version = '9.0.0'; expect(() => generateReleaseReadinessReceipt(drift)).toThrow(/identity drift/u);
    const leaked = input() as ReturnType<typeof input> & { note?: string }; leaked.note = '/Users/candidate/.npmrc'; expect(() => generateReleaseReadinessReceipt(leaked)).toThrow(/secret|path/u);
    expect(() => generateReleaseReadinessReceipt(input(), { forbiddenValues: ['fixture-secret-value'] })).not.toThrow();
    const forbidden = input() as ReturnType<typeof input> & { note?: string }; forbidden.note = 'fixture-secret-value'; expect(() => generateReleaseReadinessReceipt(forbidden, { forbiddenValues: ['fixture-secret-value'] })).toThrow(/forbidden/u);
  });

  it('rejects passing-but-incomplete, duplicate, mismatched and forged per-case execution evidence', () => {
    const complete = caseResults();
    expect(deriveReleaseCoverageAssertions(complete, { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage) })).toBeTruthy();
    expect(() => deriveReleaseCoverageAssertions(complete.slice(0, -1), { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage) })).toThrow(/incomplete/u);
    expect(() => deriveReleaseCoverageAssertions([...complete.slice(0, -1), complete[0]!], { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage) })).toThrow(/duplicated/u);
    const mismatched = structuredClone(complete); mismatched[0]!.command_hash = d('f');
    const { result_hash: ignored, ...mismatchedCore } = mismatched[0]!; void ignored; mismatched[0]!.result_hash = canonicalHash(mismatchedCore);
    expect(() => deriveReleaseCoverageAssertions(mismatched, { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage) })).toThrow(/command mismatch/u);
    const stale = structuredClone(complete); stale[0]!.source_tree = '3'.repeat(40);
    const { result_hash: staleHash, ...staleCore } = stale[0]!; void staleHash; stale[0]!.result_hash = canonicalHash(staleCore);
    expect(() => deriveReleaseCoverageAssertions(stale, { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage) })).toThrow(/stale/u);
    const failed = structuredClone(complete) as unknown as Array<Record<string, unknown>>; failed[0]!['passed'] = false;
    expect(() => deriveReleaseCoverageAssertions(failed, { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage) })).toThrow();
    const forged = structuredClone(complete); forged[0]!.observed.identity_matched = false;
    expect(() => deriveReleaseCoverageAssertions(forged, { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.coverage) })).toThrow(/forged/u);
  });

  it('rejects missing, duplicate, stale, command-mismatched, failed, or forged leakage check evidence', () => {
    const complete = leakageResults(); const binding = { sourceTree: '2'.repeat(40), commandHash: canonicalHash(RELEASE_VERIFICATION_COMMANDS.leakage) };
    expect(deriveReleaseLeakageAssertions(complete, binding).checked).toEqual(REQUIRED_RELEASE_LEAKAGE_IDS);
    expect(() => deriveReleaseLeakageAssertions(complete.slice(0, -1), binding)).toThrow(/incomplete/u);
    expect(() => deriveReleaseLeakageAssertions([...complete.slice(0, -1), complete[0]!], binding)).toThrow(/duplicated/u);
    const stale = structuredClone(complete); stale[0]!.source_tree = '3'.repeat(40);
    const { result_hash: staleHash, ...staleCore } = stale[0]!; void staleHash; stale[0]!.result_hash = canonicalHash(staleCore);
    expect(() => deriveReleaseLeakageAssertions(stale, binding)).toThrow(/stale/u);
    const mismatched = structuredClone(complete); mismatched[0]!.command_hash = d('f');
    const { result_hash: commandResultHash, ...commandCore } = mismatched[0]!; void commandResultHash; mismatched[0]!.result_hash = canonicalHash(commandCore);
    expect(() => deriveReleaseLeakageAssertions(mismatched, binding)).toThrow(/command mismatch/u);
    const failed = structuredClone(complete) as unknown as Array<Record<string, unknown>>; failed[0]!['passed'] = false;
    expect(() => deriveReleaseLeakageAssertions(failed, binding)).toThrow();
    const forged = structuredClone(complete); forged[0]!.observed.detected_classes = ['auth-credentials'];
    expect(() => deriveReleaseLeakageAssertions(forged, binding)).toThrow(/forged/u);
  });

  it('requires one successful, integrity-bound result for every readiness assertion', () => {
    const missing = input(); missing.verification_evidence.pop(); expect(() => generateReleaseReadinessReceipt(missing)).toThrow();
    const duplicated = input(); duplicated.verification_evidence[1] = duplicated.verification_evidence[0]!; expect(() => generateReleaseReadinessReceipt(duplicated)).toThrow(/missing or duplicated/u);
    const failed = input(); failed.verification_evidence[0]!.result.passed = false; failed.verification_evidence[0]!.result_hash = canonicalHash(failed.verification_evidence[0]!.result); expect(() => generateReleaseReadinessReceipt(failed)).toThrow(/evidence failed/u);
    const mismatched = input(); mismatched.verification_evidence[0]!.result_hash = d('9'); expect(() => generateReleaseReadinessReceipt(mismatched)).toThrow(/hash mismatch/u);
    const alteredEvidence = input(); alteredEvidence.verification_evidence[0]!.evidence.source_tree_after = '3'.repeat(40); expect(() => generateReleaseReadinessReceipt(alteredEvidence)).toThrow(/stale or mutated/u);
    const forged = input(); forged.verification_evidence[0]!.evidence.command.arguments = ['test']; expect(() => generateReleaseReadinessReceipt(forged)).toThrow(/command evidence mismatch/u);
    const staleOutput = input(); staleOutput.verification_evidence[1]!.evidence.output.bytes_scanned += 1; expect(() => generateReleaseReadinessReceipt(staleOutput)).toThrow(/immutable evidence mismatch/u);
  });

  it('hashes directory content and relative names without binding its host path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'readiness-hash-')); await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'file.txt'), 'content\n');
    const one = await hashReleaseDirectory(root); const copy = await mkdtemp(path.join(os.tmpdir(), 'readiness-copy-'));
    await mkdir(path.join(copy, 'nested')); await writeFile(path.join(copy, 'nested', 'file.txt'), 'content\n');
    expect(await hashReleaseDirectory(copy)).toBe(one);
  });
});

const evidencePath = process.env['YYLO_BENCHMARK_RELEASE_CASE_EVIDENCE'];
const sourceTree = process.env['YYLO_BENCHMARK_RELEASE_SOURCE_TREE'];
const commandHash = process.env['YYLO_BENCHMARK_RELEASE_COMMAND_HASH'];
const requiredEnvironment = evidencePath !== undefined || sourceTree !== undefined || commandHash !== undefined;
const exec = promisify(execFile);
const h = (digit: string) => `sha256:${digit.repeat(64)}` as `sha256:${string}`;

async function executionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-case-execution-')); const revision = '1'.repeat(64);
  const fake = await installFakeKanban(root, { tasks: { CASE1: optedInTask() }, revisions: { CASE1: revision } });
  const client = new PublicKanbanClient(fake.loaded); const repository = path.join(root, 'candidate'); await mkdir(repository);
  await exec('git', ['init', '-q'], { cwd: repository }); await exec('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
  await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
  await writeFile(path.join(repository, 'file.txt'), 'before\n'); await exec('git', ['add', '.'], { cwd: repository });
  await exec('git', ['commit', '-qm', 'base'], { cwd: repository });
  const baselineCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  const baselineTree = (await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository })).stdout.trim();
  const plan = await planExperiment(client, { taskId: 'CASE1', models: ['openai/gpt-mini'], modelSelectors: { 'openai/gpt-mini': ':mini' }, attempts: 1,
    snapshotHash: h('2'), wikiHashes: {}, toolPolicyHash: h('3'), budgetHash: h('4'), packageVersion: '0.1.0', junoVersion: '2.0.0' });
  return { client, repository, baselineCommit, baselineTree, plan, registry: new ImmutableArtifactRegistry(path.join(root, 'registry')) };
}

function telemetry(model: string, status: 'success' | 'failure', cost?: unknown) {
  const slash = model.indexOf('/');
  const envelope = { schema_version: 'juno_execution_envelope.v1', status, session_id: 'RELEASE-CASE',
    provider: model.slice(0, slash), model: model.slice(slash + 1), juno_version: '2.0.0',
    ...(cost === undefined ? {} : { cost }) };
  return reconcileJunoTelemetry({ attemptId: 'release-case', expectedModel: model, expectedJunoVersion: '2.0.0',
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.001Z', elapsedMs: 1,
    exitCode: status === 'success' ? 0 : 1, signal: null, stdout: JSON.stringify(envelope), stderr: '', patchHash: null });
}

describe('executed release-readiness case matrix', () => {
  it('emits immutable machine-readable evidence only after every required behavior executes', async () => {
    if (!requiredEnvironment) return; // Ordinary tests exercise the APIs; the release verifier requests evidence explicitly.
    expect(evidencePath && sourceTree && commandHash).toBeTruthy();
    const records = [] as ReturnType<typeof createReleaseCaseResult>[];
    const record = (caseId: ReleaseCaseId, observed: Readonly<Record<string, unknown>>) => {
      records.push(createReleaseCaseResult({ caseId, sourceTree: sourceTree!, commandHash: commandHash!, observed }));
    };

    for (const model of ['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-mini', 'openai-codex/gpt-5.6-luna', 'zai/glm-5.2'] as const) {
      const result = telemetry(model, 'success', { completeness: 'complete', usd: 0 });
      expect(result.model).toBe(model.slice(model.indexOf('/') + 1));
      record(`model:${model}`, { model, identity_matched: result.candidateSucceeded });
    }
    const success = telemetry('openai-codex/gpt-5.6-mini', 'success', { completeness: 'complete', usd: 0 });
    const failure = telemetry('openai-codex/gpt-5.6-mini', 'failure', { completeness: 'complete', usd: 1 });
    record('outcome:success', { candidate_succeeded: success.candidateSucceeded });
    record('outcome:failure', { candidate_succeeded: failure.candidateSucceeded, terminal_class: failure.result.terminal_class });
    for (const [caseId, cost] of [
      ['cost:missing', { completeness: 'unavailable', usd: null }],
      ['cost:zero', { completeness: 'complete', usd: 0 }],
      ['cost:positive', { completeness: 'complete', usd: 1.25 }],
    ] as const) {
      const observed = telemetry('openai-codex/gpt-5.6-mini', 'success', cost).result.cost;
      expect(observed).toEqual(cost); record(caseId, observed);
    }

    const fixture = await executionFixture(); let candidateCalls = 0;
    await runExperiment({ client: fixture.client, registry: fixture.registry, plan: fixture.plan,
      prepareAttempt: async () => ({ repository: fixture.repository, snapshotHash: fixture.plan.snapshot_hash, shadowHash: h('5'), baselineCommit: fixture.baselineCommit, baselineTree: fixture.baselineTree }),
      runner: async (input) => { candidateCalls += 1; await writeFile(path.join(input.repository, 'file.txt'), 'after\n'); await writeFile(path.join(input.repository, 'release.txt'), 'executed patch evidence\n');
        return { attemptId: input.attempt.attempt_id, expectedModel: input.attempt.model, expectedJunoVersion: '2.0.0', observedJunoVersion: '2.0.0', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.001Z', elapsedMs: 1, exitCode: 0, signal: null,
          stdout: JSON.stringify({ schema_version: 'juno_execution_envelope.v1', status: 'success', session_id: 'RELEASE-PATCH', provider: 'openai', model: 'gpt-mini', juno_version: '2.0.0', cost: { completeness: 'complete', usd: 0 } }), stderr: '', patchHash: null }; },
      grader: async () => ({ graderId: 'release-grader', graderVersion: '1', passed: true, output: { passed: true } }) });
    const key = fixture.plan.plan_id.slice(7); const initial = await fixture.registry.verifyExperiment(key);
    const patch = initial.find((entry) => entry.role === 'patch')!; const bytes = await fixture.registry.read(patch);
    expect(`sha256:${sha256Hex(bytes)}`).toBe(patch.sha256); expect(bytes.toString('utf8')).toContain('release.txt');
    record('patch:evidence', { patch_hash: patch.sha256, retained_bytes_verified: true });
    const before = candidateCalls;
    const regraded = await regradeExperiment({ registry: fixture.registry, plan: fixture.plan,
      grader: async () => ({ graderId: 'release-grader-v2', graderVersion: '2', passed: true, output: { passed: true } }) });
    const after = candidateCalls;
    expect(regraded).toHaveLength(1);
    record('regrade:no-candidate-rerun', { candidate_calls_before: before, candidate_calls_after: after, regraded_results: regraded.length });

    const entries = await fixture.registry.verifyExperiment(key); const attempt = initial.find((entry) => entry.role === 'attempt-contract')!;
    const attemptId = (JSON.parse((await fixture.registry.read(attempt)).toString('utf8')) as { attempt_id: string }).attempt_id;
    const receipt = await verifyRequiredGraderReceipt(fixture.registry, entries, attemptId);
    record('grader:valid', { accepted: true, receipt_hash: receipt.integrity_hash });
    await expect(verifyRequiredGraderReceipt(fixture.registry, entries.filter((entry) => entry.role !== 'grader-receipt'), attemptId)).rejects.toThrow(/missing/u);
    record('grader:missing', { rejected: true });
    expect(() => verifyGraderReceiptValue({ ...receipt, passed: !receipt.passed })).toThrow(/integrity/u);
    record('grader:tampered', { rejected: true });

    expect(records).toHaveLength(14);
    const bundle = { schema_version: 'juno_benchmark_release_case_bundle.v1', source_tree: sourceTree,
      command_hash: commandHash, results: records, results_hash: canonicalHash(records) };
    await appendFile(evidencePath!, `${JSON.stringify(bundle)}\n`, { encoding: 'utf8', flag: 'wx' });
    expect(JSON.parse(await readFile(evidencePath!, 'utf8'))).toEqual(bundle);
  });
});
