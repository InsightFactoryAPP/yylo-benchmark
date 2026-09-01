import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const hash = (bytes: Uint8Array | string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function v2() {
  return import('../../src/v2/contracts.js').catch(() => null);
}

const source = {
  repository: 'https://example.invalid/project.git',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  candidate_manifest_hash: `sha256:${'c'.repeat(64)}`,
};

const evaluator = {
  profile_id: 'shared-evaluation',
  profile_version: '1',
  kind: 'deterministic' as const,
  required: true,
  config_hash: `sha256:${'d'.repeat(64)}`,
};

describe('88c6Mi phase 1 unified v2 contracts', () => {
  it('P1-A1 normalizes task and workflow cases into one serialized AttemptPlan contract', async () => {
    const api = await v2();
    expect(api, 'v2 contract module must exist').not.toBeNull();
    const task = api!.normalizeCase({ kind: 'task', case_id: 'task-1', case_version: '1', input: { prompt: 'repair' }, source });
    const workflow = api!.normalizeCase({ kind: 'workflow', case_id: 'workflow-1', case_version: '1', input: { workflow_path: 'workflow.yaml' }, source });
    const taskPlan = api!.createAttemptPlan({ case: task, experiment_id: 'experiment-1', attempt_index: 1, harness_profile: 'fake', requested_model: 'vendor-a/model-x', workspace_backend: 'fresh_repository', evaluators: [evaluator], yylo_version: '2.0.0', benchmark_version: '2.0.0' });
    const workflowPlan = api!.createAttemptPlan({ case: workflow, experiment_id: 'experiment-1', attempt_index: 1, harness_profile: 'fake', requested_model: 'vendor-a/model-x', workspace_backend: 'fresh_repository', evaluators: [evaluator], yylo_version: '2.0.0', benchmark_version: '2.0.0' });
    expect(taskPlan.schema_version).toBe(workflowPlan.schema_version);
    expect(Object.keys(taskPlan).sort()).toEqual(Object.keys(workflowPlan).sort());
    expect(taskPlan.case.normalized_input_hash).toBe(hash('{"prompt":"repair"}'));
  });

  it('P1-A2 serializes canonical v2 case, plan, evidence, evaluation, and report provenance with yylo_version only', async () => {
    const api = await v2();
    expect(api, 'v2 contract module must exist').not.toBeNull();
    const caseValue = api!.normalizeCase({ kind: 'task', case_id: 'task-1', case_version: '1', input: { prompt: 'repair' }, source });
    const plan = api!.createAttemptPlan({ case: caseValue, experiment_id: 'experiment-1', attempt_index: 1, harness_profile: 'fake', requested_model: 'opaque:model', workspace_backend: 'fresh_repository', evaluators: [evaluator], yylo_version: '2.0.0', benchmark_version: '2.0.0' });
    const values = [caseValue, plan, api!.AttemptEvidenceV2Schema.parse({ schema_version: 'yylo_benchmark_attempt_evidence.v2', yylo_version: '2.0.0', benchmark_version: '2.0.0', attempt_id: plan.attempt_id, plan_hash: plan.plan_hash, candidate: { status: 'success', exit_code: 0, signal: null, session_id: 'session-1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z', runtime_ms: 1000, cost: { completeness: 'unavailable', usd: null } }, identity: { harness_profile: 'fake', requested_model: 'opaque:model', resolved_provider: 'vendor', resolved_model: 'model', observed_provider: 'vendor', observed_model: 'model', observed_harness_version: '1' }, workspace_receipt_hash: `sha256:${'e'.repeat(64)}`, workspace_manifest_hash: `sha256:${'d'.repeat(64)}`, artifacts: [], evidence_hash: `sha256:${'f'.repeat(64)}` }), api!.EvaluationRecordV2Schema.parse({ schema_version: 'yylo_benchmark_evaluation_record.v2', yylo_version: '2.0.0', evaluation_id: `sha256:${'1'.repeat(64)}`, attempt_id: plan.attempt_id, evidence_hash: `sha256:${'f'.repeat(64)}`, evaluator_profile_id: 'shared-evaluation', evaluator_generation: 1, evaluator_kind: 'deterministic', validity: 'valid', quality: 'resolved', required_gate: true, findings: [], cost: { completeness: 'not_applicable', usd: null }, runtime_ms: 1, provenance_hash: `sha256:${'2'.repeat(64)}` }), api!.ReportProvenanceV2Schema.parse({ schema_version: 'yylo_benchmark_report_provenance.v2', yylo_version: '2.0.0', report_id: `sha256:${'3'.repeat(64)}`, attempt_evidence_ids: [`sha256:${'f'.repeat(64)}`], evaluation_ids: [`sha256:${'1'.repeat(64)}`], evaluator_generations: [{ profile_id: 'shared-evaluation', generation: 1 }], derived_at: '2026-01-01T00:00:02.000Z' })];
    for (const value of values) {
      const serialized = api!.serializeV2(value);
      expect(serialized).toContain('"yylo_version"');
      expect(serialized).not.toContain('juno_version');
    }
  });

  it('P1-A3 projects hash-verified v1 task and workflow evidence in memory without mutating bytes', async () => {
    const api = await v2();
    expect(api, 'v2 contract module must exist').not.toBeNull();
    for (const legacy of [
      { schema_version: 'juno_benchmark_attempt.v1', attempt_id: 'a1', juno_version: '0.2.1' },
      { schema_version: 'juno_benchmark_workflow_evidence_receipt.v3', dispatch_id: `sha256:${'4'.repeat(64)}`, identity: { requested_juno_version: '0.2.1', observed_juno_version: '0.2.1' } },
    ]) {
      const bytes = Buffer.from(JSON.stringify(legacy));
      const before = Buffer.from(bytes);
      const projected = api!.projectLegacyEvidence(bytes, hash(bytes));
      expect(bytes.equals(before), 'legacy bytes remain immutable').toBe(true);
      expect(projected.source_hash).toBe(hash(bytes));
      expect(projected.projection.yylo_version ?? projected.projection.identity?.requested_yylo_version).toBe('0.2.1');
      expect(projected.read_only).toBe(true);
    }
    expect(() => api!.projectLegacyEvidence(Buffer.from('{}'), `sha256:${'0'.repeat(64)}`)).toThrow(/hash/i);
  });

  it('P1-A4 binds evaluator generation and requested/resolved/observed identities separately', async () => {
    const api = await v2();
    expect(api, 'v2 contract module must exist').not.toBeNull();
    const identity = api!.HarnessIdentityV2Schema.parse({ harness_profile: 'candidate-harness', requested_model: ':alias', resolved_provider: 'p1', resolved_model: 'm1', observed_provider: 'p2', observed_model: 'm2', observed_harness_version: '7' });
    expect(identity.requested_model).toBe(':alias');
    expect(identity.resolved_provider).toBe('p1');
    expect(identity.observed_provider).toBe('p2');
    expect(api!.EvaluatorProfileRefV2Schema.parse({ ...evaluator, generation: 7 }).generation).toBe(7);
  });
});
