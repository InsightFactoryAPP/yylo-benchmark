import { NormalizedResultV1Schema } from '../contracts/schemas.js';
import { PublicKanbanClient } from '../kanban/client.js';
import { ImmutableArtifactRegistry, type ManifestEntry } from '../registry/index.js';
import { verifyRequiredGraderReceipt } from '../grading/index.js';
import { readWorkflowEvidenceReceipts } from '../workflow/evidence.js';

export interface ExperimentDoctorResult {
  readonly ok: true;
  readonly experimentTaskId: string;
  readonly experimentId: string;
  readonly artifacts: number;
  readonly terminalAttempts: number;
}

export interface WorkflowExperimentDoctorResult {
  readonly ok: boolean;
  readonly experimentId: string;
  readonly artifacts: number;
  readonly dispatchIntents: number;
  readonly terminals: number;
  readonly evidenceReceipts: number;
  readonly judgeIntents: number;
  readonly reports: number;
  readonly harnessFailureTerminals: number;
  readonly judgeInvalid: number;
  readonly unprovenJudgeIntents: number;
  readonly ambiguousDispatches: number;
}

export function isWorkflowExperimentId(value: string): boolean {
  // Registry experiment identity for workflow plans, never a Kanban task ID.
  return /^workflow-[0-9a-f]{64}$/u.test(value);
}

/** Verify retained workflow experiment evidence from the private registry.
 *
 * Workflow experiment IDs address registry evidence, not the YYLO Ledger;
 * this route performs no Ledger read and no version probe, and a completed
 * harness-failure terminal is retained integrity truth, not a defect.
 */
export async function doctorWorkflowExperiment(registry: ImmutableArtifactRegistry, experimentId: string): Promise<WorkflowExperimentDoctorResult> {
  if (!isWorkflowExperimentId(experimentId)) throw new Error(`experiment identity is invalid: ${experimentId}`);
  await registry.doctor();
  const entries = await registry.verifyExperiment(experimentId);
  const readDispatchId = async (entry: ManifestEntry): Promise<string | null> => {
    try {
      const value = JSON.parse((await registry.read(entry)).toString('utf8')) as { dispatch_id?: unknown };
      return typeof value.dispatch_id === 'string' ? value.dispatch_id : null;
    } catch {
      throw new Error(`retained ${entry.role} bytes are malformed for ${experimentId}`);
    }
  };
  const dispatchIntents = entries.filter((entry) => entry.role === 'workflow-dispatch-intent');
  const judgeIntents = entries.filter((entry) => entry.role === 'workflow-judge-intent');
  const terminals = entries.filter((entry) => entry.role === 'workflow-step-terminal');
  const reports = entries.filter((entry) => entry.role === 'workflow-report');
  let receipts: Awaited<ReturnType<typeof readWorkflowEvidenceReceipts>> = [];
  let legacyJudgeInvalid = 0;
  try { receipts = await readWorkflowEvidenceReceipts(registry, experimentId); }
  catch (error) {
    if (!/legacy workflow (?:evidence receipt|judgement)/u.test(error instanceof Error ? error.message : String(error))) throw error;
    legacyJudgeInvalid = entries.filter((entry) => entry.role === 'workflow-evidence-receipt').length;
  }
  const judgeEnvelopes = entries.filter((entry) => entry.role === 'workflow-judge-envelope');
  const readJudgeDispatchId = async (entry: ManifestEntry): Promise<string | null> => {
    const value = JSON.parse((await registry.read(entry)).toString('utf8')) as { judge_dispatch_id?: unknown };
    return typeof value.judge_dispatch_id === 'string' ? value.judge_dispatch_id : null;
  };
  const envelopeDispatchIds = new Set(await Promise.all(judgeEnvelopes.map(readJudgeDispatchId)));
  const intentJudgeDispatchIds = await Promise.all(judgeIntents.map(readJudgeDispatchId));
  const judgeInvalid = legacyJudgeInvalid + receipts.filter((receipt) => receipt.candidate_outcome.status === 'success'
    && receipt.harness_validity.status === 'valid' && !receipt.judge_outcome.valid).length;
  const unprovenJudgeIntents = intentJudgeDispatchIds.filter((id) => id === null || !envelopeDispatchIds.has(id)).length;
  const intentDispatchIds = await Promise.all(dispatchIntents.map((entry) => readDispatchId(entry)));
  const terminalDispatchIds = new Set(await Promise.all(terminals.map((entry) => readDispatchId(entry))));
  const ambiguousDispatches = intentDispatchIds.filter((dispatchId) => dispatchId === null || !terminalDispatchIds.has(dispatchId)).length;
  return {
    ok: ambiguousDispatches === 0 && judgeInvalid === 0 && unprovenJudgeIntents === 0,
    experimentId, artifacts: entries.length, dispatchIntents: dispatchIntents.length, terminals: terminals.length,
    evidenceReceipts: receipts.length + legacyJudgeInvalid, judgeIntents: judgeIntents.length, reports: reports.length,
    harnessFailureTerminals: receipts.filter((receipt) => receipt.harness_validity.status === 'invalid').length,
    judgeInvalid, unprovenJudgeIntents, ambiguousDispatches,
  };
}

export async function doctorExperiment(client: PublicKanbanClient, registry: ImmutableArtifactRegistry, experimentTaskId: string): Promise<ExperimentDoctorResult> {
  await registry.doctor();
  const record = await client.getRevisionedTask(experimentTaskId);
  if (!record.task.feature_tags.includes('benchmark-experiment')) throw new Error(`${experimentTaskId} is not a benchmark experiment`);
  const benchmark = record.task.fields['benchmark'];
  if (typeof benchmark !== 'object' || benchmark === null) throw new Error('experiment has no benchmark index');
  const experimentId = (benchmark as { experiment_id?: unknown }).experiment_id;
  if (typeof experimentId !== 'string' || !experimentId.startsWith('sha256:')) throw new Error('experiment identity is invalid');
  const entries = await registry.verifyExperiment(experimentId.slice('sha256:'.length));
  const hashes = new Set(entries.map((entry) => entry.sha256));
  const indexed = (benchmark as { evidence?: unknown }).evidence;
  if (Array.isArray(indexed)) for (const item of indexed) {
    const digest = typeof item === 'object' && item !== null ? (item as { sha256?: unknown }).sha256 : undefined;
    if (typeof digest !== 'string' || !hashes.has(digest as `sha256:${string}`)) throw new Error('Kanban evidence index is stale or references missing bytes');
  }
  const terminal = new Map<string, ReturnType<typeof NormalizedResultV1Schema.parse>>();
  for (const entry of entries) if (entry.role === 'normalized-result') {
    const result = NormalizedResultV1Schema.parse(JSON.parse((await registry.read(entry)).toString('utf8')) as unknown);
    terminal.set(result.attempt_id, result);
  }
  for (const result of terminal.values()) if (result.resolved || result.terminal_class === 'grader_failure') {
    await verifyRequiredGraderReceipt(registry, entries, result.attempt_id);
  }
  return { ok: true, experimentTaskId, experimentId, artifacts: entries.length, terminalAttempts: terminal.size };
}
