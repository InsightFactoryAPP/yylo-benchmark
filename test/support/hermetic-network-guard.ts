/**
 * Admission hermeticity guard for the standalone juno-benchmark suite.
 *
 * The benchmark lane is a merge-queue admission lane: its results must depend
 * only on the candidate tree, so a test opening a network socket (registry or
 * API latency, outages) must fail fast instead of becoming a phantom candidate
 * failure. Mirrors juno-code/src/test-utils/hermetic-network-guard.ts; the
 * packages stay standalone. Escape hatch JUNO_TEST_ALLOW_NETWORK=1 exists but
 * no admission lane may set it.
 */
import * as net from 'node:net';

const allowNetwork = process.env.JUNO_TEST_ALLOW_NETWORK === '1';

function describeTarget(options: unknown): string {
  if (typeof options === 'object' && options !== null) {
    const record = options as Record<string, unknown>;
    if (typeof record.host === 'string' || typeof record.port === 'number') {
      return `${String(record.host)}:${String(record.port)}`;
    }
    if (typeof record.path === 'string') return record.path;
  }
  return 'unknown target';
}

function refuse(kind: string, target: string): never {
  const message = `[hermeticity] admission tests must not use the network: ${kind} -> ${target}. `
    + 'Serve the fixture from the local filesystem or a loopback in-process fake. '
    + 'Explicit override (never in admission lanes): JUNO_TEST_ALLOW_NETWORK=1.';
  throw new Error(message);
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
    if (!isUnix) refuse('net.Socket.connect', describeTarget(options));
    return originalSocketConnect.apply(this, args);
  };
}

export const hermeticNetworkGuardActive = !allowNetwork;
