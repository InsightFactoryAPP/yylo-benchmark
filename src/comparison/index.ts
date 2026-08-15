import { canonicalHash } from '../contracts/canonical.js';
import type { CostEvidence, NormalizedResultV1 } from '../contracts/schemas.js';
import type { RetainedAttempt } from '../reporting/discovery.js';

export const INVALID_TERMINAL_CLASSES = Object.freeze([
  'harness_failure', 'environment_failure', 'grader_failure', 'invalid_case', 'cancelled',
] as const satisfies readonly NormalizedResultV1['terminal_class'][]);

export interface RateEstimate {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly confidence: 'wilson-95';
  readonly interval: readonly [number, number] | null;
}
export interface CostSummary {
  readonly complete_attempts: number;
  readonly partial_attempts: number;
  readonly unavailable_attempts: number;
  readonly not_applicable_attempts: number;
  readonly complete_cost_usd: number;
  readonly partial_observed_cost_usd: number;
  readonly cost_per_success_usd: number | null;
  readonly cost_per_success_completeness: 'complete' | 'incomplete' | 'not_computable';
}
export interface RuntimeSummary { readonly sample_size: number; readonly mean_ms: number | null; readonly median_ms: number | null; readonly p95_ms: number | null }
export interface SystemMetrics {
  readonly system: { readonly agent: string; readonly provider: string; readonly model: string; readonly package_version: string; readonly juno_version: string };
  readonly sample_size: number;
  readonly valid_sample_size: number;
  readonly resolved: RateEstimate;
  readonly invalid: RateEstimate;
  readonly repeated_run_consistency: RateEstimate;
  readonly runtime: RuntimeSummary;
  readonly cost: CostSummary;
  readonly terminal_classes: Readonly<Record<string, number>>;
  readonly attempt_ids: readonly string[];
}

function rate(numerator: number, denominator: number): RateEstimate {
  if (denominator === 0) return { numerator, denominator, rate: null, confidence: 'wilson-95', interval: null };
  const estimate = numerator / denominator; const z = 1.959963984540054;
  const divisor = 1 + z * z / denominator;
  const center = (estimate + z * z / (2 * denominator)) / divisor;
  const margin = z * Math.sqrt((estimate * (1 - estimate) + z * z / (4 * denominator)) / denominator) / divisor;
  return { numerator, denominator, rate: estimate, confidence: 'wilson-95', interval: [Math.max(0, center - margin), Math.min(1, center + margin)] };
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(fraction * ordered.length) - 1));
  return ordered[index] ?? null;
}

function costSummary(costs: readonly CostEvidence[], successes: number): CostSummary {
  let complete = 0; let partial = 0; let unavailable = 0; let notApplicable = 0; let completeUsd = 0; let partialUsd = 0;
  for (const cost of costs) {
    if (cost.completeness === 'complete') { complete += 1; completeUsd += cost.usd; }
    else if (cost.completeness === 'partial') { partial += 1; partialUsd += cost.usd; }
    else if (cost.completeness === 'unavailable') unavailable += 1;
    else notApplicable += 1;
  }
  const allApplicableComplete = complete === costs.length;
  return {
    complete_attempts: complete, partial_attempts: partial, unavailable_attempts: unavailable, not_applicable_attempts: notApplicable,
    complete_cost_usd: completeUsd, partial_observed_cost_usd: partialUsd,
    cost_per_success_usd: allApplicableComplete && successes > 0 ? completeUsd / successes : null,
    cost_per_success_completeness: successes === 0 ? 'not_computable' : allApplicableComplete ? 'complete' : 'incomplete',
  };
}

export function compatibilityKey(attempt: RetainedAttempt, graderVersion: string): `sha256:${string}` {
  return canonicalHash({
    schema_version: 'juno_benchmark_comparison_compatibility.v1',
    case_input_hash: attempt.contract.case_input_hash,
    snapshot_hash: attempt.contract.snapshot_hash,
    prompt_hash: attempt.contract.prompt_hash,
    wiki_hashes: attempt.plan.wiki_hashes,
    tool_policy_hash: attempt.contract.tool_policy_hash,
    budget_hash: attempt.contract.budget_hash,
    agent: attempt.observed.agent,
    package_version: attempt.contract.package_version,
    juno_version: attempt.contract.juno_version,
    session_topology: attempt.contract.session_topology,
    grader_version: graderVersion,
  });
}

/** Compute separate, transparent dimensions. Invalid attempts remain in the invalid denominator but not model reliability. */
export function compareAttempts(attempts: readonly RetainedAttempt[]): readonly SystemMetrics[] {
  const groups = new Map<string, RetainedAttempt[]>();
  for (const attempt of attempts) {
    const identity = `${attempt.observed.agent}\0${attempt.observed.provider}\0${attempt.observed.model}\0${attempt.contract.package_version}\0${attempt.contract.juno_version}`;
    groups.set(identity, [...(groups.get(identity) ?? []), attempt]);
  }
  return Object.freeze([...groups.values()].map((items): SystemMetrics => {
    const first = items[0]; if (first === undefined) throw new Error('empty comparison group');
    const invalid = items.filter((item) => INVALID_TERMINAL_CLASSES.includes(item.result.terminal_class as typeof INVALID_TERMINAL_CLASSES[number]));
    const valid = items.filter((item) => !invalid.includes(item));
    const successes = valid.filter((item) => item.result.resolved).length;
    const modal = valid.length === 0 ? 0 : Math.max(successes, valid.length - successes);
    const runtimes = items.map((item) => item.result.elapsed_ms);
    const classes: Record<string, number> = {};
    for (const item of items) classes[item.result.terminal_class] = (classes[item.result.terminal_class] ?? 0) + 1;
    return {
      system: { agent: first.observed.agent, provider: first.observed.provider, model: first.observed.model, package_version: first.contract.package_version, juno_version: first.contract.juno_version },
      sample_size: items.length, valid_sample_size: valid.length,
      resolved: rate(successes, valid.length), invalid: rate(invalid.length, items.length),
      repeated_run_consistency: rate(modal, valid.length),
      runtime: { sample_size: runtimes.length, mean_ms: runtimes.length === 0 ? null : runtimes.reduce((sum, item) => sum + item, 0) / runtimes.length, median_ms: percentile(runtimes, 0.5), p95_ms: percentile(runtimes, 0.95) },
      cost: costSummary(items.map((item) => item.result.cost), successes), terminal_classes: classes,
      attempt_ids: Object.freeze(items.map((item) => item.contract.attempt_id).sort()),
    };
  }).sort((left, right) => left.system.model.localeCompare(right.system.model)));
}
