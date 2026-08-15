import { NormalizedResultV1Schema, type NormalizedResultV1 } from '../contracts/schemas.js';
import { ImmutableArtifactRegistry } from '../registry/index.js';

export interface RecoveryState {
  readonly terminal: ReadonlyMap<string, NormalizedResultV1>;
  readonly dispatchedWithoutTerminal: ReadonlySet<string>;
}

/** Inspect only durable markers. Callers must never redispatch IDs in dispatchedWithoutTerminal. */
export async function inspectRecovery(registry: ImmutableArtifactRegistry, experimentId: string): Promise<RecoveryState> {
  const terminal = new Map<string, NormalizedResultV1>(); const dispatched = new Set<string>();
  for (const entry of await registry.verifyExperiment(experimentId)) {
    if (entry.role === 'attempt-dispatched') {
      const value = JSON.parse((await registry.read(entry)).toString('utf8')) as { attempt_id?: unknown };
      if (typeof value.attempt_id !== 'string') throw new Error('invalid attempt dispatch marker');
      dispatched.add(value.attempt_id);
    } else if (entry.role === 'normalized-result') {
      const value = NormalizedResultV1Schema.parse(JSON.parse((await registry.read(entry)).toString('utf8')) as unknown);
      // Regrading appends a newer immutable result generation; the manifest order
      // deterministically selects the current one without rewriting candidate truth.
      terminal.set(value.attempt_id, value);
    }
  }
  return { terminal, dispatchedWithoutTerminal: new Set([...dispatched].filter((id) => !terminal.has(id))) };
}
