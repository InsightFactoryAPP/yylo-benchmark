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

// ── Admission hermeticity guard ──────────────────────────────────────────────
// This lane is a merge-queue admission lane: its results must depend only on
// the candidate tree, so a test opening a network socket (registry or API
// latency, outages) must fail fast instead of becoming a phantom candidate
// failure. Registering this module as a vitest setupFile applies the guard in
// every worker before tests run. Escape hatch JUNO_TEST_ALLOW_NETWORK=1 exists
// but no admission lane may set it.

import * as net from 'node:net';

const allowNetwork = process.env.JUNO_TEST_ALLOW_NETWORK === '1';

function describeGuardTarget(options: unknown): string {
  if (typeof options === 'object' && options !== null) {
    const record = options as Record<string, unknown>;
    if (typeof record.host === 'string' || typeof record.port === 'number') {
      return `${String(record.host)}:${String(record.port)}`;
    }
    if (typeof record.path === 'string') return record.path;
  }
  return 'unknown target';
}

function refuseNetwork(kind: string, target: string): never {
  throw new Error(
    `[hermeticity] admission tests must not use the network: ${kind} -> ${target}. `
    + 'Serve the fixture from the local filesystem or a loopback in-process fake. '
    + 'Explicit override (never in admission lanes): JUNO_TEST_ALLOW_NETWORK=1.');
}

function isLoopbackTarget(options: unknown): boolean {
  if (typeof options !== 'object' || options === null) return false;
  const record = options as Record<string, unknown>;
  if (record.path !== undefined) return false; // unix domain socket: always local
  const host = typeof record.host === 'string' ? record.host : null;
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

if (!allowNetwork) {
  // Patching the prototype method covers net.createConnection, net.connect,
  // and every higher-level client because they all funnel new outbound
  // connections through Socket.prototype.connect.
  const prototype = net.Socket.prototype as unknown as Record<string,
    (this: net.Socket, ...args: unknown[]) => unknown>;
  const originalSocketConnect = prototype.connect as (
    this: net.Socket, ...args: unknown[]) => unknown;
  prototype.connect = function hermeticConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const options = args.find((arg) => typeof arg === 'object' && arg !== null);
    const isUnix = typeof options === 'object'
      && options !== null
      && typeof (options as Record<string, unknown>).path === 'string';
    if (!isUnix && !isLoopbackTarget(options)) {
      refuseNetwork('net.Socket.connect', describeGuardTarget(options));
    }
    return originalSocketConnect.apply(this, args);
  };
}

export const hermeticNetworkGuardActive = !allowNetwork;
