import { canonicalHash } from '../contracts/canonical.js';
import {
  AttemptV1Schema,
  GraderResultV1Schema,
  NormalizedResultV1Schema,
  type AttemptV1,
  type GraderResultV1,
  type NormalizedResultV1,
} from '../contracts/schemas.js';
import type { PublicKanbanClient } from '../kanban/client.js';
import type { ExecutionPlan } from '../planning/index.js';
import { ImmutableArtifactRegistry, type ArtifactReference, type ManifestEntry } from '../registry/index.js';

export interface RetainedAttempt {
  readonly experimentTaskId: string;
  readonly experimentId: string;
  readonly plan: ExecutionPlan;
  readonly contract: AttemptV1;
  readonly result: NormalizedResultV1;
  readonly observed: { readonly agent: string; readonly provider: string; readonly model: string };
  readonly graders: readonly GraderResultV1[];
  readonly artifacts: ReadonlyMap<string, readonly ManifestEntry[]>;
  readonly provenance: readonly ArtifactReference[];
}

export interface RetainedCaseEvidence {
  readonly taskId: string;
  readonly sourceRevision: string;
  readonly attempts: readonly RetainedAttempt[];
  readonly experimentIds: readonly string[];
}

function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch (error) { throw new Error(`invalid retained ${label} JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function planFrom(value: unknown): ExecutionPlan {
  if (typeof value !== 'object' || value === null) throw new Error('invalid retained execution plan');
  const plan = value as ExecutionPlan;
  const { plan_id: claimed, ...core } = plan;
  if (claimed !== canonicalHash(core)) throw new Error('retained execution plan hash is invalid');
  return plan;
}

function artifactMap(entries: readonly ManifestEntry[]): ReadonlyMap<string, readonly ManifestEntry[]> {
  const result = new Map<string, ManifestEntry[]>();
  for (const entry of entries) result.set(entry.role, [...(result.get(entry.role) ?? []), entry]);
  return result;
}

function exactlyOne<T>(values: readonly T[], label: string): T {
  if (values.length !== 1 || values[0] === undefined) throw new Error(`expected exactly one ${label}, found ${values.length}`);
  return values[0];
}

/** Discover canonical experiment relations first, then hash-verify every retained manifest object before parsing it. */
export async function discoverRetainedCaseEvidence(
  client: PublicKanbanClient,
  registry: ImmutableArtifactRegistry,
  taskId: string,
): Promise<RetainedCaseEvidence> {
  const source = await client.getRevisionedTask(taskId);
  const records = await client.listRelatedRecords('experiment', taskId);
  const attempts: RetainedAttempt[] = [];
  const seenAttempts = new Set<string>();
  const experimentIds: string[] = [];

  for (const record of records) {
    const benchmark = record.task.fields['benchmark'];
    if (typeof benchmark !== 'object' || benchmark === null) throw new Error(`experiment ${record.task.id} has no benchmark index`);
    const indexed = benchmark as { experiment_id?: unknown; source_task_id?: unknown };
    if (indexed.source_task_id !== taskId || typeof indexed.experiment_id !== 'string' || !indexed.experiment_id.startsWith('sha256:')) {
      throw new Error(`experiment ${record.task.id} has incompatible canonical identity`);
    }
    const experimentId = indexed.experiment_id;
    const entries = await registry.verifyExperiment(experimentId.slice('sha256:'.length));
    const byRole = artifactMap(entries);
    const planEntry = exactlyOne(byRole.get('execution-plan') ?? [], `execution plan for ${experimentId}`);
    const plan = planFrom(parseJson(await registry.read(planEntry), 'execution plan'));
    if (plan.plan_id !== experimentId || plan.case.task_id !== taskId) throw new Error(`experiment ${record.task.id} plan identity disagrees with Kanban`);

    const contracts = new Map<string, AttemptV1>();
    const contractEntries = new Map<string, ManifestEntry>();
    for (const entry of byRole.get('attempt-contract') ?? []) {
      const contract = AttemptV1Schema.parse(parseJson(await registry.read(entry), 'attempt contract'));
      if (contract.experiment_id !== experimentId || contracts.has(contract.attempt_id)) throw new Error(`duplicate or mismatched attempt contract ${contract.attempt_id}`);
      contracts.set(contract.attempt_id, contract); contractEntries.set(contract.attempt_id, entry);
    }
    const graders = new Map<string, GraderResultV1[]>();
    const graderEntries = new Map<string, ManifestEntry[]>();
    for (const entry of byRole.get('grader-result') ?? []) {
      const grader = GraderResultV1Schema.parse(parseJson(await registry.read(entry), 'grader result'));
      graders.set(grader.attempt_id, [...(graders.get(grader.attempt_id) ?? []), grader]);
      graderEntries.set(grader.attempt_id, [...(graderEntries.get(grader.attempt_id) ?? []), entry]);
    }
    const latestResults = new Map<string, { result: NormalizedResultV1; entry: ManifestEntry }>();
    for (const entry of byRole.get('normalized-result') ?? []) {
      const result = NormalizedResultV1Schema.parse(parseJson(await registry.read(entry), 'normalized result'));
      latestResults.set(result.attempt_id, { result, entry });
    }
    for (const { result, entry } of latestResults.values()) {
      const contract = contracts.get(result.attempt_id);
      if (contract === undefined) throw new Error(`normalized result ${result.attempt_id} has no retained contract`);
      if (seenAttempts.has(result.attempt_id)) throw new Error(`attempt ${result.attempt_id} appears in multiple experiments`);
      seenAttempts.add(result.attempt_id);
      const contractEntry = contractEntries.get(result.attempt_id);
      if (contractEntry === undefined) throw new Error(`attempt ${result.attempt_id} has no contract reference`);
      let terminalEntry = (byRole.get('structured-juno-evidence') ?? []).find((item) => item.sha256 === result.terminal_evidence_hash);
      let identity: { attempt_id?: unknown; agent?: unknown; provider?: unknown; model?: unknown; envelope?: unknown } = {};
      if (terminalEntry !== undefined) {
        const terminal = parseJson(await registry.read(terminalEntry), 'structured terminal evidence');
        if (typeof terminal !== 'object' || terminal === null) throw new Error(`attempt ${result.attempt_id} terminal evidence is invalid`);
        identity = terminal;
      } else {
        // Recovery evidence predating hash-bound terminal identity is retained but cannot claim an observed provider.
        for (const candidate of byRole.get('structured-juno-evidence') ?? []) {
          const terminal = parseJson(await registry.read(candidate), 'structured terminal evidence');
          if (typeof terminal === 'object' && terminal !== null && (terminal as { attempt_id?: unknown }).attempt_id === result.attempt_id) { terminalEntry = candidate; identity = terminal; break; }
        }
      }
      if (identity.attempt_id !== undefined && identity.attempt_id !== result.attempt_id) throw new Error(`attempt ${result.attempt_id} terminal identity disagrees`);
      const envelope = typeof identity.envelope === 'object' && identity.envelope !== null ? identity.envelope as { provider?: unknown; model?: unknown } : {};
      attempts.push({
        experimentTaskId: record.task.id,
        experimentId,
        plan,
        contract,
        result,
        observed: Object.freeze({ agent: typeof identity.agent === 'string' ? identity.agent : contract.agent, provider: typeof envelope.provider === 'string' ? envelope.provider : contract.provider, model: typeof envelope.model === 'string' ? envelope.model : contract.model }),
        graders: Object.freeze([...(graders.get(result.attempt_id) ?? [])]),
        artifacts: byRole,
        provenance: Object.freeze([planEntry, contractEntry, ...(terminalEntry === undefined ? [] : [terminalEntry]), entry, ...(graderEntries.get(result.attempt_id) ?? [])]),
      });
    }
    experimentIds.push(experimentId);
  }
  return Object.freeze({ taskId, sourceRevision: source.revision, attempts: Object.freeze(attempts), experimentIds: Object.freeze(experimentIds) });
}
