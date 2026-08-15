import { describe, expect, it } from 'vitest';
import { investigateRetainedEvidence, privacyScanAndRedact } from '../../src/investigation/index.js';
import { retainedFixture } from '../reporting/retained-fixture.js';

describe('bounded retained-evidence investigation', () => {
  it('redacts common private data deterministically', () => {
    const result = privacyScanAndRedact('email a.person@example.com password=hunter22 Bearer abcdefghijk');
    expect(result.text).not.toContain('example.com'); expect(result.text).not.toContain('hunter22'); expect(result.findings.length).toBeGreaterThan(1);
  });

  it('uses a fakeable agent, omits full transcripts, stores immutable layers, and creates exactly one related record', async () => {
    const item = await retainedFixture(); await item.addAttempt({ model: ':mini', resolved: false }); let calls = 0; let observedPacket = '';
    const agent = async (input: Parameters<Parameters<typeof investigateRetainedEvidence>[0]['agent']>[0]) => {
      calls += 1; observedPacket = JSON.stringify(input.packet);
      return { analysis: 'Likely patch issue. analyst@example.com', agent: 'fake-juno', provider: 'fixture', model: ':fake', session_id: 'INV1', elapsed_ms: 12, cost: { completeness: 'not_applicable' as const, usd: null } };
    };
    const first = await investigateRetainedEvidence({ client: item.client, registry: item.registry, taskId: 'CASE1', question: 'Why did it fail?', agent });
    expect(calls).toBe(1); expect(observedPacket).toContain('[REDACTED:email-address]'); expect(observedPacket).toContain('[REDACTED:credential-assignment]'); expect(observedPacket).not.toContain('FULL PRIVATE TRANSCRIPT');
    const retained = (await item.registry.read(first.artifact)).toString('utf8'); expect(retained).not.toContain('analyst@example.com'); expect(retained).toContain('[REDACTED:email-address]');
    const second = await investigateRetainedEvidence({ client: item.client, registry: item.registry, taskId: 'CASE1', question: 'Why did it fail?', agent });
    expect(second.recovered).toBe(true); expect(calls).toBe(1); expect(item.investigations).toHaveLength(1);
  });

  it('refuses packets over the configured bound before invoking an agent', async () => {
    const item = await retainedFixture(); await item.addAttempt({ model: ':mini' }); let calls = 0;
    await expect(investigateRetainedEvidence({ client: item.client, registry: item.registry, taskId: 'CASE1', question: 'Why?', maxPacketBytes: 100, agent: async () => { calls += 1; throw new Error('must not run'); } })).rejects.toThrow(/packet exceeds/u);
    expect(calls).toBe(0);
  });
});
