import * as os from 'node:os';

/**
 * Contention-aware test budgets for the standalone juno-benchmark suite.
 *
 * Admission suites run on shared machines where ambient load can exceed CPU
 * capacity for minutes. Fixed deadlines that are tight on an idle machine fail
 * on a loaded one even though the candidate is correct. These helpers scale a
 * base budget by the current one-minute load ratio (loadavg / cpus), clamped
 * to [min, max] (default [1, 4]): exact base value on quiet machines, at most
 * max times the base under heavy oversubscription. Mirrors
 * juno-code/src/test-utils/contention-budget.ts; the packages stay standalone.
 */
export interface ContentionBudgetOptions {
  readonly minMultiplier?: number;
  readonly maxMultiplier?: number;
}

export function contentionMultiplier(options: ContentionBudgetOptions = {}): number {
  const min = options.minMultiplier ?? 1;
  const max = options.maxMultiplier ?? 4;
  if (!(max >= min) || !(min > 0)) throw new Error(`invalid contention multiplier bounds: min=${min} max=${max}`);
  const cpus = Math.max(1, os.cpus().length);
  const load = Math.max(0, os.loadavg()[0] ?? 0);
  return Math.min(max, Math.max(min, load / cpus));
}

export function contentionBudgetMs(baseMs: number, options: ContentionBudgetOptions = {}): number {
  if (!(baseMs > 0)) throw new Error(`invalid contention budget base: ${baseMs}`);
  return Math.ceil((baseMs * contentionMultiplier(options)) / 50) * 50;
}
