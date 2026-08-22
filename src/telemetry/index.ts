import { canonicalHash } from '../contracts/canonical.js';
import {
  JunoExecutionEnvelopeV1Schema,
  NormalizedResultV1Schema,
  type JunoExecutionEnvelopeV1,
  type NormalizedResultV1,
} from '../contracts/schemas.js';

export interface ProcessEvidence {
  readonly attemptId: string;
  readonly expectedModel: string;
  readonly expectedJunoVersion: string;
  readonly observedJunoVersion?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly patchHash: `sha256:${string}` | null;
}

export interface ReconciledTelemetry {
  readonly result: NormalizedResultV1;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly agent: 'yylo';
  readonly provider: string;
  readonly model: string;
  readonly junoVersion: string;
  readonly sessionId: string | null;
  readonly candidateSucceeded: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Parse the final JSON object without treating arbitrary preceding logs as evidence. */
export function finalStructuredObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { const parsed = object(JSON.parse(lines[index]!) as unknown); if (parsed !== null) return parsed; }
    catch { /* a normal progress line */ }
  }
  return null;
}

function parseEnvelope(stdout: string): JunoExecutionEnvelopeV1 | null {
  const payload = finalStructuredObject(stdout);
  const parsed = JunoExecutionEnvelopeV1Schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** Reconcile only the public Juno envelope. Candidate-authored nested fields are never identity or grading truth. */
export function reconcileJunoTelemetry(input: ProcessEvidence): ReconciledTelemetry {
  const envelope = parseEnvelope(input.stdout);
  const [expectedProvider, ...modelParts] = input.expectedModel.split('/');
  const expectedBareModel = modelParts.join('/');
  const provider = envelope?.provider ?? 'unknown';
  const model = envelope?.model ?? 'unknown';
  const junoVersion = envelope?.juno_version ?? input.observedJunoVersion ?? 'unknown';
  const sessionId = envelope?.session_id ?? null;
  const identityMatches = expectedProvider !== '' && expectedBareModel !== '' && provider === expectedProvider && model === expectedBareModel;
  const versionMatches = junoVersion === input.expectedJunoVersion &&
    (input.observedJunoVersion === undefined || input.observedJunoVersion === junoVersion);

  let terminalClass: NormalizedResultV1['terminal_class'];
  if (input.cancelled === true || input.signal === 'SIGINT' || input.signal === 'SIGTERM' || envelope?.status === 'cancelled') terminalClass = 'cancelled';
  else if (input.timedOut === true || envelope?.status === 'timeout') terminalClass = 'timeout';
  else if (envelope === null || !identityMatches || !versionMatches) terminalClass = 'harness_failure';
  else if (input.exitCode !== 0 || envelope.status !== 'success') terminalClass = 'model_failure';
  else terminalClass = 'model_failure'; // successful execution remains unresolved until governed grading

  const candidateSucceeded = envelope !== null && identityMatches && versionMatches && input.exitCode === 0 && envelope.status === 'success';
  const terminalEvidence = {
    schema_version: 'juno_benchmark_juno_terminal_evidence.v1', attempt_id: input.attemptId,
    envelope, expected_identity: { provider: expectedProvider, model: expectedBareModel },
    executable_version: input.observedJunoVersion ?? null, exit_code: input.exitCode,
    signal: input.signal, stderr_present: input.stderr.length > 0,
  } as const;
  const result = NormalizedResultV1Schema.parse({
    schema_version: 'juno_benchmark_normalized_result.v1', attempt_id: input.attemptId,
    resolved: false, terminal_class: terminalClass, session_id: sessionId,
    started_at: input.startedAt, ended_at: input.endedAt, elapsed_ms: input.elapsedMs,
    cost: envelope?.cost ?? { completeness: 'unavailable', usd: null }, patch_hash: input.patchHash,
    terminal_evidence_hash: canonicalHash(terminalEvidence),
  });
  return { result, evidence: terminalEvidence, agent: 'yylo', provider, model, junoVersion, sessionId, candidateSucceeded };
}
