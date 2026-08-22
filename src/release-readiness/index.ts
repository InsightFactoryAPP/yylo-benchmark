import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalHash, canonicalJson, sha256Hex } from '../contracts/canonical.js';

export const RELEASE_READINESS_VERSION = 'juno_benchmark_release_readiness.v1' as const;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const identity = z.object({ name: z.string().min(1), version: z.string().min(1) }).strict();

export const REQUIRED_RELEASE_CASE_IDS = Object.freeze([
  'model:openai-codex/gpt-5.6-sol', 'model:openai-codex/gpt-5.6-mini',
  'model:openai-codex/gpt-5.6-luna', 'model:zai/glm-5.2',
  'outcome:success', 'outcome:failure',
  'cost:missing', 'cost:zero', 'cost:positive', 'patch:evidence',
  'grader:valid', 'grader:missing', 'grader:tampered', 'regrade:no-candidate-rerun',
] as const);
export type ReleaseCaseId = (typeof REQUIRED_RELEASE_CASE_IDS)[number];

export const ReleaseCaseResultSchema = z.object({
  schema_version: z.literal('juno_benchmark_release_case_result.v1'),
  case_id: z.enum(REQUIRED_RELEASE_CASE_IDS), source_tree: objectId, command_hash: digest,
  observed: z.record(z.unknown()), passed: z.literal(true), result_hash: digest,
}).strict();
export type ReleaseCaseResult = z.infer<typeof ReleaseCaseResultSchema>;

function observationPasses(caseId: ReleaseCaseId, value: Record<string, unknown>): boolean {
  if (caseId.startsWith('model:')) return value['model'] === caseId.slice(6) && value['identity_matched'] === true;
  if (caseId === 'outcome:success') return value['candidate_succeeded'] === true;
  if (caseId === 'outcome:failure') return value['candidate_succeeded'] === false && value['terminal_class'] === 'model_failure';
  if (caseId === 'cost:missing') return value['completeness'] === 'unavailable' && value['usd'] === null;
  if (caseId === 'cost:zero') return value['completeness'] === 'complete' && value['usd'] === 0;
  if (caseId === 'cost:positive') return value['completeness'] === 'complete' && typeof value['usd'] === 'number' && value['usd'] > 0;
  if (caseId === 'patch:evidence') return digest.safeParse(value['patch_hash']).success && value['retained_bytes_verified'] === true;
  if (caseId === 'grader:valid') return value['accepted'] === true && digest.safeParse(value['receipt_hash']).success;
  if (caseId === 'grader:missing' || caseId === 'grader:tampered') return value['rejected'] === true;
  return value['candidate_calls_before'] === value['candidate_calls_after'] && value['regraded_results'] === 1;
}

/** Create a case result only from a case-specific observed outcome; callers cannot assert pass directly. */
export function createReleaseCaseResult(input: {
  readonly caseId: ReleaseCaseId; readonly sourceTree: string; readonly commandHash: string;
  readonly observed: Readonly<Record<string, unknown>>;
}): ReleaseCaseResult {
  if (!observationPasses(input.caseId, input.observed as Record<string, unknown>)) throw new Error(`release case ${input.caseId} observation failed`);
  const core = { schema_version: 'juno_benchmark_release_case_result.v1' as const, case_id: input.caseId,
    source_tree: input.sourceTree, command_hash: input.commandHash, observed: input.observed, passed: true as const };
  return ReleaseCaseResultSchema.parse({ ...core, result_hash: canonicalHash(core) });
}

/** Validate the exact executed case matrix and derive, rather than accept, readiness assertions. */
export function deriveReleaseCoverageAssertions(raw: unknown, binding: { readonly sourceTree: string; readonly commandHash: string }) {
  const records = z.array(ReleaseCaseResultSchema).parse(raw);
  const found = new Map<ReleaseCaseId, ReleaseCaseResult>();
  for (const record of records) {
    if (found.has(record.case_id)) throw new Error(`release case evidence duplicated: ${record.case_id}`);
    const { result_hash: claimed, ...core } = record;
    if (claimed !== canonicalHash(core) || !observationPasses(record.case_id, record.observed)) throw new Error(`release case evidence forged: ${record.case_id}`);
    if (record.source_tree !== binding.sourceTree) throw new Error(`release case evidence stale: ${record.case_id}`);
    if (record.command_hash !== binding.commandHash) throw new Error(`release case command mismatch: ${record.case_id}`);
    found.set(record.case_id, record);
  }
  const missing = REQUIRED_RELEASE_CASE_IDS.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`release case evidence incomplete: ${missing.join(', ')}`);
  if (records.length !== REQUIRED_RELEASE_CASE_IDS.length) throw new Error('release case evidence contains unexpected cases');
  return {
    models: ['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-mini', 'openai-codex/gpt-5.6-luna', 'zai/glm-5.2'],
    outcomes: ['success', 'failure'], cost_cases: ['missing', 'zero', 'positive'], patch_evidence: true,
    grader_receipt_cases: ['valid', 'missing', 'tampered'], regrade_without_candidate_rerun: true,
  } as const;
}

export const REQUIRED_RELEASE_LEAKAGE_IDS = Object.freeze([
  'private-registry', 'auth-credentials', 'candidate-home-xdg',
  'canonical-controller-route', 'host-paths', 'candidate-git-metadata',
] as const);
export type ReleaseLeakageId = (typeof REQUIRED_RELEASE_LEAKAGE_IDS)[number];
const leakageId = z.enum(REQUIRED_RELEASE_LEAKAGE_IDS);
const leakageLog = z.object({ stdout_hash: digest, stderr_hash: digest, combined_hash: digest }).strict();
const leakageCheckOutput = z.object({
  synthetic_artifact_hash: digest, bytes_scanned: z.number().int().positive(), detector: leakageId,
  detected_classes: z.array(z.string().min(1)).min(1),
}).strict();
export const ReleaseLeakageResultSchema = z.object({
  schema_version: z.literal('juno_benchmark_release_leakage_result.v1'), check_id: leakageId,
  source_tree: objectId, command_hash: digest,
  observed: z.object({ detected: z.literal(true), rejected: z.literal(true), detected_classes: z.array(z.string().min(1)).min(1) }).strict(),
  output: leakageCheckOutput, output_hash: digest, log: leakageLog, log_hash: digest,
  passed: z.literal(true), result_hash: digest,
}).strict();
export type ReleaseLeakageResult = z.infer<typeof ReleaseLeakageResultSchema>;

/** Derive leakage assertions only from complete, executed, immutable positive-control results. */
export function deriveReleaseLeakageAssertions(raw: unknown, binding: { readonly sourceTree: string; readonly commandHash: string }) {
  const records = z.array(ReleaseLeakageResultSchema).parse(raw);
  const found = new Map<ReleaseLeakageId, ReleaseLeakageResult>();
  for (const record of records) {
    if (found.has(record.check_id)) throw new Error(`release leakage evidence duplicated: ${record.check_id}`);
    const { result_hash: claimed, ...core } = record;
    if (claimed !== canonicalHash(core) || record.output_hash !== canonicalHash(record.output) ||
        record.log.combined_hash !== canonicalHash({ stdout_hash: record.log.stdout_hash, stderr_hash: record.log.stderr_hash }) ||
        record.log_hash !== canonicalHash(record.log) || record.output.detector !== record.check_id ||
        !record.output.detected_classes.includes(record.check_id) || !record.observed.detected_classes.includes(record.check_id)) {
      throw new Error(`release leakage evidence forged: ${record.check_id}`);
    }
    if (record.source_tree !== binding.sourceTree) throw new Error(`release leakage evidence stale: ${record.check_id}`);
    if (record.command_hash !== binding.commandHash) throw new Error(`release leakage command mismatch: ${record.check_id}`);
    found.set(record.check_id, record);
  }
  const missing = REQUIRED_RELEASE_LEAKAGE_IDS.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`release leakage evidence incomplete: ${missing.join(', ')}`);
  if (records.length !== REQUIRED_RELEASE_LEAKAGE_IDS.length) throw new Error('release leakage evidence contains unexpected checks');
  return { checked: [...REQUIRED_RELEASE_LEAKAGE_IDS] } as { checked: [ReleaseLeakageId, ReleaseLeakageId, ReleaseLeakageId, ReleaseLeakageId, ReleaseLeakageId, ReleaseLeakageId] };
}

const coverage = z.object({
  models: z.tuple([z.literal('openai-codex/gpt-5.6-sol'), z.literal('openai-codex/gpt-5.6-mini'), z.literal('openai-codex/gpt-5.6-luna'), z.literal('zai/glm-5.2')]),
  outcomes: z.tuple([z.literal('success'), z.literal('failure')]),
  cost_cases: z.tuple([z.literal('missing'), z.literal('zero'), z.literal('positive')]),
  patch_evidence: z.literal(true), grader_receipt_cases: z.tuple([z.literal('valid'), z.literal('missing'), z.literal('tampered')]),
  regrade_without_candidate_rerun: z.literal(true),
}).strict();
const leakage = z.object({ checked: z.tuple([
  z.literal('private-registry'), z.literal('auth-credentials'), z.literal('candidate-home-xdg'),
  z.literal('canonical-controller-route'), z.literal('host-paths'), z.literal('candidate-git-metadata'),
]) }).strict();

export const RELEASE_VERIFICATION_COMMANDS = Object.freeze({
  coverage: Object.freeze({ executable: 'npm', arguments: Object.freeze(['exec', '--', 'vitest', 'run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=text']), cwd: 'juno-benchmark', timeout_ms: 120_000, stdin: 'closed' }),
  leakage: Object.freeze({ executable: 'node', arguments: Object.freeze(['../juno-code/scripts/scan-benchmark-release-artifacts.mjs', 'dist', '../juno-code/dist', '.release-evidence/yylo-benchmark.tgz', '.release-evidence/yylo-cli.tgz']), cwd: 'juno-benchmark', timeout_ms: 30_000, stdin: 'closed' }),
} as const);
const command = z.object({ executable: z.string().min(1), arguments: z.array(z.string()), cwd: z.literal('juno-benchmark'), timeout_ms: z.number().int().min(1).max(120_000), stdin: z.literal('closed') }).strict();
const execution = z.object({ exit_code: z.literal(0), signal: z.null(), timed_out: z.literal(false) }).strict();
const log = z.object({ stdout_hash: digest, stderr_hash: digest, combined_hash: digest }).strict();
const coverageOutput = z.object({
  test_files_passed: z.number().int().positive(), tests_passed: z.number().int().positive(), coverage_summary_hash: digest,
  case_results: z.array(ReleaseCaseResultSchema), case_results_hash: digest,
}).strict();
const leakageOutput = z.object({
  files_scanned: z.number().int().positive(), bytes_scanned: z.number().int().positive(), canaries_checked: z.literal(6),
  sensitive_environment_values_checked: z.number().int().nonnegative(), check_results: z.array(ReleaseLeakageResultSchema),
  check_results_hash: digest, bundle_hash: digest,
}).strict();
const evidenceDescriptor = <K extends 'coverage' | 'leakage'>(kind: K, output: K extends 'coverage' ? typeof coverageOutput : typeof leakageOutput) => z.object({
  schema_version: z.literal('juno_benchmark_release_verification_evidence.v2'), assertion_kind: z.literal(kind),
  source_tree_before: objectId, source_tree_after: objectId, command, command_hash: digest, execution,
  output, output_hash: digest, log, log_hash: digest, result_hash: digest,
}).strict();
const verificationEvidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coverage'), evidence: evidenceDescriptor('coverage', coverageOutput), evidence_hash: digest, result_hash: digest,
    result: z.object({ passed: z.boolean(), case_results_hash: digest }).strict() }).strict(),
  z.object({ kind: z.literal('leakage'), evidence: evidenceDescriptor('leakage', leakageOutput), evidence_hash: digest, result_hash: digest,
    result: z.object({ passed: z.boolean(), assertions: leakage }).strict() }).strict(),
]);

export const ReleaseReadinessInputSchema = z.object({
  source: z.object({ commit: objectId, tree: objectId, clean: z.literal(true), packages: z.array(identity).length(2) }).strict(),
  artifacts: z.array(z.object({ package: z.enum(['@yylo/benchmark', '@yylo/cli']), kind: z.enum(['source', 'dist', 'npm_tarball']), version: z.string().min(1), sha256: digest }).strict()).length(6),
  cli_identities: z.array(z.object({ installation: z.enum(['built', 'installed']), surface: z.enum(['standalone', 'delegate']), benchmark_version: z.string().min(1), juno_code_version: z.string().min(1).nullable() }).strict()).length(4),
  verification_evidence: z.array(verificationEvidence).length(2),
}).strict();

export const RELEASE_EXCLUSIONS = Object.freeze([
  'live-workflow-cases', 'typed-production-resource-locks', 'frontier-paid-judging',
  'paid-sol-dispatch', 'paid-mini-dispatch', 'paid-luna-dispatch', 'paid-zai-glm-dispatch',
] as const);

export const ReleaseReadinessReceiptSchema = ReleaseReadinessInputSchema.extend({
  schema_version: z.literal(RELEASE_READINESS_VERSION),
  coverage,
  leakage: leakage.extend({ passed: z.literal(true) }).strict(),
  exclusions: z.array(z.enum(RELEASE_EXCLUSIONS)).length(RELEASE_EXCLUSIONS.length),
  integrity_hash: digest,
}).strict();

const REQUIRED_ARTIFACTS = new Set([
  '@yylo/benchmark:source', '@yylo/benchmark:dist', '@yylo/benchmark:npm_tarball',
  '@yylo/cli:source', '@yylo/cli:dist', '@yylo/cli:npm_tarball',
]);
const REQUIRED_CLIS = new Set(['built:standalone', 'built:delegate', 'installed:standalone', 'installed:delegate']);

function rejectLeakage(serialized: string, forbiddenValues: readonly string[]): void {
  if (/(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\\\Users\\\\[^\\\s]+\\\\)|(?:https?:\/\/[^\s"]+@)|"(?:[^"]*(?:token|password|secret|auth_token|registry_url|candidate_home|candidate_xdg)[^"]*)"\s*:\s*"[^"]+"|_authToken\s*=|registry\.npmjs\.org\//iu.test(serialized)) {
    throw new Error('release-readiness evidence contains a secret, registry, candidate environment, or host path signature');
  }
  for (const value of forbiddenValues) {
    if (value.length >= 4 && serialized.includes(value)) throw new Error('release-readiness evidence contains a forbidden runtime value');
  }
}

/** Build a deterministic, path-free receipt from independently measured release identities and immutable verification results. */
export function generateReleaseReadinessReceipt(raw: unknown, options: { readonly forbiddenValues?: readonly string[] } = {}): z.infer<typeof ReleaseReadinessReceiptSchema> {
  const inputText = canonicalJson(raw);
  rejectLeakage(inputText, options.forbiddenValues ?? []);
  const input = ReleaseReadinessInputSchema.parse(raw);
  if (new Set(input.artifacts.map((item) => `${item.package}:${item.kind}`)).size !== REQUIRED_ARTIFACTS.size ||
      input.artifacts.some((item) => !REQUIRED_ARTIFACTS.has(`${item.package}:${item.kind}`))) throw new Error('release-readiness artifact matrix is incomplete or duplicated');
  if (new Set(input.cli_identities.map((item) => `${item.installation}:${item.surface}`)).size !== REQUIRED_CLIS.size) throw new Error('release-readiness CLI matrix is incomplete or duplicated');
  const evidenceKinds = new Set(input.verification_evidence.map((item) => item.kind));
  if (evidenceKinds.size !== 2 || !evidenceKinds.has('coverage') || !evidenceKinds.has('leakage')) throw new Error('release-readiness verification evidence is missing or duplicated');
  for (const item of input.verification_evidence) {
    if (!item.result.passed) throw new Error(`release-readiness ${item.kind} evidence failed`);
    if (item.result_hash !== canonicalHash(item.result)) throw new Error(`release-readiness ${item.kind} evidence result hash mismatch`);
    const evidence = item.evidence;
    const expectedCommand = RELEASE_VERIFICATION_COMMANDS[item.kind];
    if (canonicalJson(evidence.command) !== canonicalJson(expectedCommand) || evidence.command_hash !== canonicalHash(evidence.command)) {
      throw new Error(`release-readiness ${item.kind} command evidence mismatch`);
    }
    if (evidence.source_tree_before !== input.source.tree || evidence.source_tree_after !== input.source.tree) {
      throw new Error(`release-readiness ${item.kind} stale or mutated source evidence`);
    }
    if (evidence.output_hash !== canonicalHash(evidence.output) || evidence.log.combined_hash !== canonicalHash({ stdout_hash: evidence.log.stdout_hash, stderr_hash: evidence.log.stderr_hash }) ||
        evidence.log_hash !== canonicalHash(evidence.log) || evidence.result_hash !== item.result_hash || item.evidence_hash !== canonicalHash(evidence)) {
      throw new Error(`release-readiness ${item.kind} immutable evidence mismatch`);
    }
  }
  const versions = new Map(input.source.packages.map((item) => [item.name, item.version]));
  for (const artifact of input.artifacts) if (versions.get(artifact.package) !== artifact.version) throw new Error(`artifact version drift for ${artifact.package}`);
  const benchmarkVersion = versions.get('@yylo/benchmark'); const junoVersion = versions.get('@yylo/cli');
  for (const cli of input.cli_identities) {
    if (cli.benchmark_version !== benchmarkVersion) throw new Error('benchmark CLI identity drift');
    if (cli.surface === 'delegate' && cli.juno_code_version !== junoVersion) throw new Error('delegate YYLO identity drift');
    if (cli.surface === 'standalone' && cli.juno_code_version !== null) throw new Error('standalone identity must not claim a delegate');
  }
  const coverageEvidence = input.verification_evidence.find((item) => item.kind === 'coverage')!;
  const leakageEvidence = input.verification_evidence.find((item) => item.kind === 'leakage')!;
  if (coverageEvidence.evidence.output.case_results_hash !== canonicalHash(coverageEvidence.evidence.output.case_results) ||
      coverageEvidence.result.case_results_hash !== coverageEvidence.evidence.output.case_results_hash) {
    throw new Error('release-readiness coverage case result hash mismatch');
  }
  const derivedCoverage = deriveReleaseCoverageAssertions(coverageEvidence.evidence.output.case_results, {
    sourceTree: input.source.tree, commandHash: coverageEvidence.evidence.command_hash,
  });
  if (leakageEvidence.evidence.output.check_results_hash !== canonicalHash(leakageEvidence.evidence.output.check_results)) {
    throw new Error('release-readiness leakage check result hash mismatch');
  }
  const leakageBundleCore = {
    schema_version: 'juno_benchmark_release_leakage_bundle.v1', source_tree: input.source.tree,
    command_hash: leakageEvidence.evidence.command_hash, results: leakageEvidence.evidence.output.check_results,
    results_hash: leakageEvidence.evidence.output.check_results_hash,
  };
  if (leakageEvidence.evidence.output.bundle_hash !== canonicalHash(leakageBundleCore)) {
    throw new Error('release-readiness leakage bundle hash mismatch');
  }
  const derivedLeakage = deriveReleaseLeakageAssertions(leakageEvidence.evidence.output.check_results, {
    sourceTree: input.source.tree, commandHash: leakageEvidence.evidence.command_hash,
  });
  if (canonicalJson(leakageEvidence.result.assertions) !== canonicalJson(derivedLeakage)) {
    throw new Error('release-readiness leakage assertions do not match executed evidence');
  }
  const core = {
    schema_version: RELEASE_READINESS_VERSION, ...input,
    coverage: derivedCoverage,
    leakage: { passed: true, ...derivedLeakage },
    exclusions: [...RELEASE_EXCLUSIONS],
  } as const;
  rejectLeakage(canonicalJson(core), options.forbiddenValues ?? []);
  return ReleaseReadinessReceiptSchema.parse({ ...core, integrity_hash: canonicalHash(core) });
}

export async function hashReleaseDirectory(root: string): Promise<`sha256:${string}`> {
  const entries: { path: string; sha256: string }[] = [];
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix === '' ? item.name : `${prefix}/${item.name}`; const absolute = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('release artifact directory contains a symbolic link');
      if (item.isDirectory()) await walk(absolute, relative);
      else if (item.isFile()) entries.push({ path: relative, sha256: `sha256:${sha256Hex(await readFile(absolute))}` });
      else throw new Error('release artifact directory contains a non-regular entry');
    }
  }
  await walk(root);
  return canonicalHash(entries);
}
