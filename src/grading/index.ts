import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHash, canonicalJson, sha256Hex } from '../contracts/canonical.js';
import {
  GraderReceiptV1Schema,
  GraderResultV1Schema,
  NormalizedResultV1Schema,
  type AttemptV1,
  type GraderReceiptV1,
  type NormalizedResultV1,
} from '../contracts/schemas.js';
import { ImmutableArtifactRegistry, type ManifestEntry } from '../registry/index.js';

export interface GraderInvocation {
  readonly attempt: AttemptV1;
  readonly profile: string;
  readonly input: Readonly<Record<string, unknown>>;
}
export interface GraderDecision {
  readonly graderId: string;
  readonly graderVersion: string;
  readonly passed: boolean;
  readonly output: unknown;
}
export type GraderRunner = (invocation: GraderInvocation) => Promise<GraderDecision>;

/** Create a governed grader bound to immutable executable bytes and configured identity. */
export function createCommandGrader(options: {
  readonly executable: string; readonly arguments?: readonly string[]; readonly graderId: string;
  readonly graderVersion: string; readonly sha256: `sha256:${string}`; readonly cwd?: string; readonly timeoutMs?: number;
}): GraderRunner {
  return async (invocation) => {
    const executable = path.resolve(options.cwd ?? process.cwd(), options.executable);
    const metadata = await lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('grader executable is not a regular file');
    const before = await readFile(executable);
    if (`sha256:${sha256Hex(before)}` !== options.sha256) throw new Error('grader executable hash mismatch');
    const child = spawn(executable, [...(options.arguments ?? [])], { cwd: options.cwd, env: { PATH: process.env['PATH'] ?? '' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stdin.end(`${canonicalJson(invocation.input)}\n`);
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 120_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
    if (timedOut) throw new Error('grader timed out');
    if (`sha256:${sha256Hex(await readFile(executable))}` !== options.sha256) throw new Error('grader executable changed during grading');
    if (code !== 0) throw new Error(`grader failed (${code ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`);
    const outputText = Buffer.concat(stdout).toString('utf8').trim();
    const output = JSON.parse(outputText) as unknown;
    const passed = typeof output === 'object' && output !== null && (output as { passed?: unknown }).passed;
    if (typeof passed !== 'boolean') throw new Error('grader output must contain boolean passed');
    return { graderId: options.graderId, graderVersion: options.graderVersion, passed, output };
  };
}

async function append(registry: ImmutableArtifactRegistry, experimentId: string, role: string, value: unknown): Promise<ManifestEntry> {
  const reference = await registry.put(role, `${canonicalJson(value)}\n`);
  const existing = (await registry.verifyExperiment(experimentId)).find((entry) => entry.role === role && entry.sha256 === reference.sha256);
  return existing ?? registry.append(experimentId, reference);
}

export function verifyGraderReceiptValue(receipt: unknown): GraderReceiptV1 {
  const parsed = GraderReceiptV1Schema.parse(receipt);
  const { integrity_hash: claimed, ...core } = parsed;
  if (claimed !== canonicalHash(core)) throw new Error(`grader receipt integrity failed for ${parsed.attempt_id}`);
  return parsed;
}

export async function verifyRequiredGraderReceipt(
  registry: ImmutableArtifactRegistry,
  entries: readonly ManifestEntry[],
  attemptId: string,
): Promise<GraderReceiptV1> {
  const receipts = entries.filter((entry) => entry.role === 'grader-receipt');
  let receipt: GraderReceiptV1 | undefined;
  for (const entry of [...receipts].reverse()) {
    const candidate = verifyGraderReceiptValue(JSON.parse((await registry.read(entry)).toString('utf8')) as unknown);
    if (candidate.attempt_id === attemptId) { receipt = candidate; break; }
  }
  if (receipt === undefined) throw new Error(`required grader receipt missing for ${attemptId}`);
  const byHash = new Map(entries.map((entry) => [entry.sha256, entry]));
  for (const [label, digest] of [['input', receipt.input_hash], ['output', receipt.output_hash], ['result', receipt.result_hash]] as const) {
    const entry = byHash.get(digest as `sha256:${string}`);
    if (entry === undefined) throw new Error(`grader receipt ${label} is missing for ${attemptId}`);
    await registry.read(entry);
  }
  const resultEntry = byHash.get(receipt.result_hash as `sha256:${string}`)!;
  const result = GraderResultV1Schema.parse(JSON.parse((await registry.read(resultEntry)).toString('utf8')) as unknown);
  if (result.attempt_id !== attemptId || result.passed !== receipt.passed || result.grader_id !== receipt.grader_id || result.grader_version !== receipt.grader_version) {
    throw new Error(`grader result does not match receipt for ${attemptId}`);
  }
  return receipt;
}

function finalResult(candidate: NormalizedResultV1, candidateSucceeded: boolean, passed: boolean, evidenceHash: `sha256:${string}`): NormalizedResultV1 {
  const terminalClass = candidateSucceeded ? (passed ? 'resolved' : 'grader_failure') : candidate.terminal_class;
  return NormalizedResultV1Schema.parse({ ...candidate, resolved: terminalClass === 'resolved', terminal_class: terminalClass, terminal_evidence_hash: evidenceHash });
}

/** Grade immutable candidate evidence and append a self-authenticating receipt. */
export async function gradeRetainedAttempt(input: {
  readonly registry: ImmutableArtifactRegistry;
  readonly experimentId: string;
  readonly attempt: AttemptV1;
  readonly profile: string;
  readonly candidateResult: NormalizedResultV1;
  readonly candidateSucceeded: boolean;
  readonly runner?: GraderRunner | undefined;
}): Promise<NormalizedResultV1> {
  const graderInput = {
    schema_version: 'juno_benchmark_grader_input.v1', attempt: input.attempt,
    profile: input.profile, candidate_succeeded: input.candidateSucceeded,
    patch_hash: input.candidateResult.patch_hash, terminal_evidence_hash: input.candidateResult.terminal_evidence_hash,
  } as const;
  const inputEntry = await append(input.registry, input.experimentId, 'grader-input', graderInput);
  let decision: GraderDecision;
  try {
    if (input.runner === undefined) throw new Error(`grader profile is not configured: ${input.profile}`);
    decision = await input.runner({ attempt: input.attempt, profile: input.profile, input: graderInput });
    if (!decision.graderId.trim() || !decision.graderVersion.trim()) throw new Error('grader identity is incomplete');
  } catch (error) {
    decision = { graderId: `missing:${input.profile}`, graderVersion: 'unavailable', passed: false,
      output: { error: error instanceof Error ? error.message : String(error) } };
  }
  const outputEntry = await append(input.registry, input.experimentId, 'grader-output', decision.output);
  const resultValue = GraderResultV1Schema.parse({ schema_version: 'juno_benchmark_grader_result.v1', attempt_id: input.attempt.attempt_id,
    grader_id: decision.graderId, grader_version: decision.graderVersion, required: true,
    passed: input.candidateSucceeded && decision.passed, evidence_hash: outputEntry.sha256 });
  const resultEntry = await append(input.registry, input.experimentId, 'grader-result', resultValue);
  const receiptCore = { schema_version: 'juno_benchmark_grader_receipt.v1' as const, attempt_id: input.attempt.attempt_id,
    grader_profile: input.profile, grader_id: resultValue.grader_id, grader_version: resultValue.grader_version,
    required: true as const, passed: resultValue.passed, input_hash: inputEntry.sha256, output_hash: outputEntry.sha256, result_hash: resultEntry.sha256 };
  const receipt = { ...receiptCore, integrity_hash: canonicalHash(receiptCore) };
  await append(input.registry, input.experimentId, 'grader-receipt', receipt);
  await verifyRequiredGraderReceipt(input.registry, await input.registry.verifyExperiment(input.experimentId), input.attempt.attempt_id);
  return finalResult(input.candidateResult, input.candidateSucceeded, receipt.passed, receipt.integrity_hash);
}
