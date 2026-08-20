import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { hermeticNetworkGuardActive } from './support/hermetic-network-guard.js';

describe('benchmark admission hermeticity guard', () => {
  it('is active in the default test environment', () => {
    expect(process.env.JUNO_TEST_ALLOW_NETWORK).toBeUndefined();
    expect(hermeticNetworkGuardActive).toBe(true);
  });

  it('refuses new network connections with an actionable message', () => {
    expect(() => net.createConnection({ host: 'registry.npmjs.invalid', port: 443 }))
      .toThrow(/admission tests must not use the network: net\.Socket\.connect/);
    const socket = new net.Socket();
    expect(() => socket.connect({ host: 'example.invalid', port: 80 }))
      .toThrow(/admission tests must not use the network: net\.Socket\.connect/);
  });

  it('keeps unix domain socket connects available for local fixtures', () => {
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    expect(() => socket.connect({ path: '/nonexistent-juno-benchmark-hermeticity.sock' }))
      .not.toThrow(/admission tests must not use the network/);
    socket.destroy();
  });
});
