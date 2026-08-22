import { spawn } from 'node:child_process';
import { canonicalHash, canonicalJson } from '../contracts/canonical.js';
import type { CostEvidence } from '../contracts/schemas.js';
import type { PublicKanbanClient } from '../kanban/client.js';
import { ImmutableArtifactRegistry, type ArtifactReference } from '../registry/index.js';
import { discoverRetainedCaseEvidence } from '../reporting/discovery.js';

export const INVESTIGATION_VERSION = 'juno_benchmark_investigation.v1' as const;
export const EVIDENCE_PACKET_VERSION = 'juno_benchmark_investigation_packet.v1' as const;
const DEFAULT_MAX_PACKET_BYTES = 128 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024;
const DEFAULT_MAX_ATTEMPTS = 100;
const MAX_QUESTION_BYTES = 8 * 1024;
const MAX_ANALYSIS_BYTES = 256 * 1024;
const MAX_SELECTED_REFERENCES_PER_ATTEMPT = 20;

export interface InvestigationAgentInput { readonly question: string; readonly packet: Readonly<Record<string, unknown>>; readonly timeoutMs: number }
export interface InvestigationAgentResult {
  readonly analysis: string;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly session_id: string | null;
  readonly elapsed_ms: number;
  readonly cost: CostEvidence;
}
export type InvestigationAgent = (input: InvestigationAgentInput) => Promise<InvestigationAgentResult>;
export interface InvestigationOutcome {
  readonly investigation_id: `sha256:${string}`;
  readonly record_task_id: string;
  readonly artifact: ArtifactReference;
  readonly packet_artifact: ArtifactReference;
  readonly recovered: boolean;
}

interface PrivacyFinding { readonly kind: string; readonly count: number }
const PRIVACY_PATTERNS: readonly { readonly kind: string; readonly expression: RegExp }[] = [
  { kind: 'private-key', expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu },
  { kind: 'bearer-token', expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu },
  { kind: 'credential-assignment', expression: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*[^\s,;]{6,}/giu },
  { kind: 'email-address', expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu },
];

export function privacyScanAndRedact(text: string): { readonly text: string; readonly findings: readonly PrivacyFinding[] } {
  let redacted = text; const findings: PrivacyFinding[] = [];
  for (const pattern of PRIVACY_PATTERNS) {
    let count = 0;
    redacted = redacted.replace(pattern.expression, () => { count += 1; return `[REDACTED:${pattern.kind}]`; });
    if (count > 0) findings.push({ kind: pattern.kind, count });
  }
  return { text: redacted, findings: Object.freeze(findings) };
}

function boundedText(bytes: Buffer, maximum: number): { readonly text: string; readonly truncated: boolean } {
  if (bytes.length <= maximum) return { text: bytes.toString('utf8'), truncated: false };
  return { text: bytes.subarray(0, maximum).toString('utf8'), truncated: true };
}

async function selectedArtifact(registry: ImmutableArtifactRegistry, reference: ArtifactReference, maximum: number): Promise<Readonly<Record<string, unknown>>> {
  const bounded = boundedText(await registry.read(reference), maximum);
  const scanned = privacyScanAndRedact(bounded.text);
  return Object.freeze({ role: reference.role, sha256: reference.sha256, size: reference.size, truncated: bounded.truncated, content: scanned.text, privacy_findings: scanned.findings });
}

async function buildPacket(options: {
  readonly client: PublicKanbanClient; readonly registry: ImmutableArtifactRegistry; readonly taskId: string;
  readonly maxPacketBytes: number; readonly maxArtifactBytes: number; readonly maxAttempts: number;
}): Promise<{ readonly packet: Readonly<Record<string, unknown>>; readonly packetHash: `sha256:${string}`; readonly sourceHashes: readonly `sha256:${string}`[] }> {
  const retained = await discoverRetainedCaseEvidence(options.client, options.registry, options.taskId);
  if (retained.attempts.length > options.maxAttempts) throw new Error(`investigation attempt limit exceeded (${retained.attempts.length} > ${options.maxAttempts})`);
  const attempts: Readonly<Record<string, unknown>>[] = []; const sourceHashes = new Set<`sha256:${string}`>();
  for (const attempt of retained.attempts) {
    const selected: Readonly<Record<string, unknown>>[] = [];
    const patch = attempt.result.patch_hash === null ? undefined : (attempt.artifacts.get('patch') ?? []).find((entry) => entry.sha256 === attempt.result.patch_hash);
    const roles = [...(patch === undefined ? [] : [patch]), ...(attempt.artifacts.get('grader-result') ?? []), ...(attempt.artifacts.get('grader-receipt') ?? []), ...(attempt.artifacts.get('transcript-reference') ?? [])];
    if (roles.length > MAX_SELECTED_REFERENCES_PER_ATTEMPT) throw new Error(`attempt ${attempt.contract.attempt_id} exceeds the selected-reference safety bound`);
    for (const reference of roles) { sourceHashes.add(reference.sha256); selected.push(await selectedArtifact(options.registry, reference, options.maxArtifactBytes)); }
    for (const reference of attempt.provenance) sourceHashes.add(reference.sha256);
    attempts.push(Object.freeze({
      attempt_id: attempt.contract.attempt_id, experiment_id: attempt.experimentId,
      agent: attempt.observed.agent, provider: attempt.observed.provider, model: attempt.observed.model,
      result: attempt.result, selected_evidence: Object.freeze(selected),
    }));
  }
  const core = {
    schema_version: EVIDENCE_PACKET_VERSION, task_id: retained.taskId, source_revision_observed: retained.sourceRevision,
    includes_full_transcripts: false, attempt_count: attempts.length, attempts: Object.freeze(attempts),
    source_hashes: Object.freeze([...sourceHashes].sort()),
  } as const;
  const serialized = canonicalJson(core);
  if (Buffer.byteLength(serialized) > options.maxPacketBytes) throw new Error(`privacy-scanned investigation packet exceeds ${options.maxPacketBytes} bytes`);
  return { packet: Object.freeze(core), packetHash: canonicalHash(core), sourceHashes: core.source_hashes };
}

function parseRetainedInvestigation(bytes: Buffer): { readonly analysis: string } {
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || typeof (value as { analysis?: unknown }).analysis !== 'string') throw new Error('retained investigation artifact is invalid');
  return value as { analysis: string };
}

export async function investigateRetainedEvidence(options: {
  readonly client: PublicKanbanClient; readonly registry: ImmutableArtifactRegistry; readonly taskId: string; readonly question: string;
  readonly agent: InvestigationAgent; readonly investigationVersion?: string; readonly agentPromptVersion?: string;
  readonly timeoutMs?: number; readonly maxPacketBytes?: number; readonly maxArtifactBytes?: number; readonly maxAttempts?: number;
}): Promise<InvestigationOutcome> {
  if (options.question.trim() === '') throw new Error('investigation question must be non-empty');
  if (Buffer.byteLength(options.question) > MAX_QUESTION_BYTES) throw new Error(`investigation question exceeds ${MAX_QUESTION_BYTES} bytes`);
  const investigationVersion = options.investigationVersion ?? INVESTIGATION_VERSION;
  const agentPromptVersion = options.agentPromptVersion ?? 'bounded-evidence-analysis.v1';
  const packet = await buildPacket({ client: options.client, registry: options.registry, taskId: options.taskId,
    maxPacketBytes: options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES, maxArtifactBytes: options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES, maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS });
  const questionHash = canonicalHash({ question: options.question });
  const investigationId = canonicalHash({ schema_version: 'juno_benchmark_investigation_identity.v1', investigation_version: investigationVersion,
    agent_prompt_version: agentPromptVersion, task_id: options.taskId, question_hash: questionHash, packet_hash: packet.packetHash });
  const existing = await options.client.findRelatedRecord({ kind: 'investigation', sourceTaskId: options.taskId, recordId: investigationId });
  const derivedId = `investigation-${investigationId.slice('sha256:'.length)}`;
  if (existing !== null) {
    const entry = (await options.registry.verifyExperiment(derivedId)).find((item) => item.role === 'investigation');
    const packetEntry = (await options.registry.verifyExperiment(derivedId)).find((item) => item.role === 'investigation-packet');
    if (entry === undefined || packetEntry === undefined) throw new Error('canonical investigation record has incomplete retained evidence');
    parseRetainedInvestigation(await options.registry.read(entry));
    return { investigation_id: investigationId, record_task_id: existing.task.id, artifact: entry, packet_artifact: packetEntry, recovered: true };
  }
  const scannedQuestion = privacyScanAndRedact(options.question);
  const result = await options.agent({ question: scannedQuestion.text, packet: packet.packet, timeoutMs: options.timeoutMs ?? 5 * 60_000 });
  if (Buffer.byteLength(result.analysis) > MAX_ANALYSIS_BYTES) throw new Error(`investigation analysis exceeds ${MAX_ANALYSIS_BYTES} bytes`);
  const scannedAnalysis = privacyScanAndRedact(result.analysis);
  const packetArtifact = await options.registry.put('investigation-packet', `${canonicalJson({ ...packet.packet, packet_hash: packet.packetHash })}\n`);
  const artifactBody = {
    schema_version: INVESTIGATION_VERSION, investigation_id: investigationId, investigation_version: investigationVersion,
    agent_prompt_version: agentPromptVersion, task_id: options.taskId, question_hash: questionHash, packet_hash: packet.packetHash,
    source_hashes: packet.sourceHashes, question_privacy_findings: scannedQuestion.findings,
    analysis: scannedAnalysis.text, analysis_privacy_findings: scannedAnalysis.findings,
    agent: { name: result.agent, provider: result.provider, model: result.model, session_id: result.session_id, elapsed_ms: result.elapsed_ms, cost: result.cost },
  } as const;
  const artifact = await options.registry.put('investigation', `${canonicalJson(artifactBody)}\n`);
  await options.registry.append(derivedId, packetArtifact); await options.registry.append(derivedId, artifact);
  const source = await options.client.getRevisionedTask(options.taskId);
  const record = await options.client.createRelatedRecord({ kind: 'investigation', sourceTaskId: options.taskId, sourceRevision: source.revision, recordId: investigationId,
    title: `Benchmark investigation ${options.taskId}`,
    benchmark: { schema_version: 'juno_benchmark_investigation_ref.v1', record_id: investigationId, investigation_id: investigationId,
      investigation_version: investigationVersion, agent_prompt_version: agentPromptVersion, source_task_id: options.taskId, source_revision: source.revision,
      question_hash: questionHash, packet_hash: packet.packetHash, evidence: [packetArtifact, artifact] } });
  const receipt = await options.registry.put('kanban-mutation-receipt', `${canonicalJson(record.receipt)}\n`); await options.registry.append(derivedId, receipt);
  return { investigation_id: investigationId, record_task_id: record.task.id, artifact, packet_artifact: packetArtifact, recovered: false };
}

export function createJunoInvestigationAgent(options: { readonly executable?: string; readonly leadingArguments?: readonly string[] } = {}): InvestigationAgent {
  return async (input) => {
    const executable = options.executable ?? process.env['YYLO_BENCHMARK_JUNO_EXECUTABLE'] ?? 'yy';
    const prompt = `Answer the bounded benchmark investigation question using only the privacy-scanned packet. Do not request or infer full transcripts.\nQuestion: ${input.question}\nPacket: ${canonicalJson(input.packet)}`;
    const started = process.hrtime.bigint();
    const child = spawn(executable, [...(options.leadingArguments ?? []), 'pi', prompt], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let overflow = false;
    const collect = (target: Buffer[]) => (chunk: Buffer): void => { bytes += chunk.length; if (bytes > 512 * 1024) { overflow = true; child.kill('SIGKILL'); } else target.push(chunk); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    let timedOut = false; let force: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 1_000); }, input.timeoutMs);
    const closed = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); })
      .finally(() => { clearTimeout(timeout); if (force !== undefined) clearTimeout(force); });
    if (overflow) throw new Error('Juno investigation output exceeded 524288 bytes');
    if (timedOut) throw new Error(`Juno investigation timed out after ${input.timeoutMs}ms`);
    if (closed.code !== 0) throw new Error(`Juno investigation failed (${closed.code ?? closed.signal ?? 'unknown'}): ${Buffer.concat(stderr).toString('utf8').trim() || 'no stderr'}`);
    return { analysis: Buffer.concat(stdout).toString('utf8').trim(), agent: 'yylo', provider: 'configured', model: 'configured', session_id: null,
      elapsed_ms: Number((process.hrtime.bigint() - started) / 1_000_000n), cost: { completeness: 'unavailable', usd: null } };
  };
}
