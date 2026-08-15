import { canonicalHash, canonicalJson } from '../contracts/canonical.js';
import type { PublicKanbanClient } from '../kanban/client.js';
import { ImmutableArtifactRegistry, type ArtifactReference } from '../registry/index.js';
import { compareAttempts, compatibilityKey, type SystemMetrics } from '../comparison/index.js';
import { discoverRetainedCaseEvidence, type RetainedAttempt } from './discovery.js';

export const REPORT_VERSION = 'juno_benchmark_longitudinal_report.v1' as const;
export const DEFAULT_GRADER_LAYER = 'normalized-result.v1' as const;

export interface ReportCohort {
  readonly compatibility_key: `sha256:${string}`;
  readonly compatibility: Readonly<Record<string, unknown>>;
  readonly experiment_ids: readonly string[];
  readonly attempt_count: number;
  readonly systems: readonly SystemMetrics[];
  readonly provenance_hashes: readonly `sha256:${string}`[];
}
export interface LongitudinalReport {
  readonly schema_version: typeof REPORT_VERSION;
  readonly report_id: `sha256:${string}`;
  readonly report_version: string;
  readonly grader_version: string;
  readonly task_id: string;
  readonly source_revision_observed: string;
  readonly experiment_ids: readonly string[];
  readonly total_attempts: number;
  readonly cohorts: readonly ReportCohort[];
  readonly incompatibilities: readonly { readonly left: `sha256:${string}`; readonly right: `sha256:${string}`; readonly reason: 'compatibility_inputs_differ' }[];
}
export interface StoredLongitudinalReport { readonly report: LongitudinalReport; readonly artifact: ArtifactReference }

function compatibility(attempt: RetainedAttempt): Readonly<Record<string, unknown>> {
  return Object.freeze({
    case_input_hash: attempt.contract.case_input_hash, snapshot_hash: attempt.contract.snapshot_hash,
    prompt_hash: attempt.contract.prompt_hash, wiki_hashes: attempt.plan.wiki_hashes,
    tool_policy_hash: attempt.contract.tool_policy_hash, budget_hash: attempt.contract.budget_hash,
    agent: attempt.observed.agent, package_version: attempt.contract.package_version,
    juno_version: attempt.contract.juno_version, session_topology: attempt.contract.session_topology,
  });
}

export async function buildLongitudinalReport(options: {
  readonly client: PublicKanbanClient;
  readonly registry: ImmutableArtifactRegistry;
  readonly taskId: string;
  readonly reportVersion?: string;
  readonly graderVersion?: string;
}): Promise<LongitudinalReport> {
  const reportVersion = options.reportVersion ?? REPORT_VERSION;
  const graderVersion = options.graderVersion ?? DEFAULT_GRADER_LAYER;
  if (reportVersion.trim() === '' || graderVersion.trim() === '') throw new Error('report and grader versions must be non-empty');
  const evidence = await discoverRetainedCaseEvidence(options.client, options.registry, options.taskId);
  const grouped = new Map<`sha256:${string}`, RetainedAttempt[]>();
  for (const attempt of evidence.attempts) {
    if (graderVersion !== DEFAULT_GRADER_LAYER && !attempt.graders.some((grader) => grader.grader_version === graderVersion)) continue;
    const key = compatibilityKey(attempt, graderVersion);
    grouped.set(key, [...(grouped.get(key) ?? []), attempt]);
  }
  const cohorts = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, attempts]): ReportCohort => {
    const first = attempts[0]; if (first === undefined) throw new Error('empty report cohort');
    const provenance = new Set<`sha256:${string}`>();
    for (const attempt of attempts) for (const reference of attempt.provenance) provenance.add(reference.sha256);
    return Object.freeze({
      compatibility_key: key, compatibility: compatibility(first),
      experiment_ids: Object.freeze([...new Set(attempts.map((item) => item.experimentId))].sort()),
      attempt_count: attempts.length, systems: compareAttempts(attempts),
      provenance_hashes: Object.freeze([...provenance].sort()),
    });
  });
  const incompatibilities: LongitudinalReport['incompatibilities'][number][] = [];
  for (let left = 0; left < cohorts.length; left += 1) for (let right = left + 1; right < cohorts.length; right += 1) {
    const a = cohorts[left]; const b = cohorts[right];
    if (a !== undefined && b !== undefined) incompatibilities.push({ left: a.compatibility_key, right: b.compatibility_key, reason: 'compatibility_inputs_differ' });
  }
  const core = {
    schema_version: REPORT_VERSION, report_version: reportVersion, grader_version: graderVersion,
    task_id: evidence.taskId, source_revision_observed: evidence.sourceRevision,
    experiment_ids: evidence.experimentIds, total_attempts: cohorts.reduce((sum, cohort) => sum + cohort.attempt_count, 0),
    cohorts, incompatibilities,
  } as const;
  return Object.freeze({ ...core, report_id: canonicalHash(core) }) as LongitudinalReport;
}

/** Retain each report version as a new derived manifest layer; source experiment manifests are never changed. */
export async function storeLongitudinalReport(registry: ImmutableArtifactRegistry, report: LongitudinalReport): Promise<StoredLongitudinalReport> {
  const artifact = await registry.put('report', `${canonicalJson(report)}\n`);
  const derivedId = `report-${report.report_id.slice('sha256:'.length)}`;
  const entries = await registry.verifyExperiment(derivedId);
  if (!entries.some((entry) => entry.role === artifact.role && entry.sha256 === artifact.sha256)) await registry.append(derivedId, artifact);
  return { report, artifact };
}

export async function generateLongitudinalReport(options: Parameters<typeof buildLongitudinalReport>[0]): Promise<StoredLongitudinalReport> {
  return storeLongitudinalReport(options.registry, await buildLongitudinalReport(options));
}

export * from './discovery.js';
