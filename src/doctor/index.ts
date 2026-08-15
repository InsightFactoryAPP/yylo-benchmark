import { NormalizedResultV1Schema } from '../contracts/schemas.js';
import { PublicKanbanClient } from '../kanban/client.js';
import { ImmutableArtifactRegistry } from '../registry/index.js';
import { verifyRequiredGraderReceipt } from '../grading/index.js';

export interface ExperimentDoctorResult {
  readonly ok: true;
  readonly experimentTaskId: string;
  readonly experimentId: string;
  readonly artifacts: number;
  readonly terminalAttempts: number;
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
