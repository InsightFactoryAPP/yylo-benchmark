import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalHash } from '../contracts/canonical.js';
import { PACKAGE_VERSION } from '../cli/program.js';
import { loadConfig } from '../config/index.js';
import { PublicKanbanClient } from '../kanban/client.js';
import { planExperiment, type ExecutionPlan } from './index.js';
import { buildSnapshot } from '../snapshot/index.js';
import { hashProjectWikis } from '../wiki/index.js';
import { planWorkflowFromProject, type WorkflowExecutionPlan } from '../workflow/plan.js';

export async function createPlanFromProject(input: { cwd: string; configPath?: string; taskId: string; models: readonly string[]; attempts: number; aggregateMaxUsd?: number }): Promise<ExecutionPlan> {
  const loaded = await loadConfig({ cwd: input.cwd, ...(input.configPath === undefined ? {} : { configPath: input.configPath }) });
  const modelSelectors: Record<string, string> = {};
  const models = input.models.map((selector) => {
    const exact = selector.startsWith(':') ? loaded.config.model_aliases[selector] : selector;
    if (exact === undefined) throw new Error(`model alias ${selector} has no exact binding in model_aliases`);
    if (!/^[^:/\s]+\/[^:/\s]+$/u.test(exact)) throw new Error(`model ${selector} does not resolve to an exact provider/model identity`);
    if (modelSelectors[exact] !== undefined && modelSelectors[exact] !== selector) throw new Error(`model selectors ${modelSelectors[exact]} and ${selector} resolve to the same exact model`);
    modelSelectors[exact] = selector;
    return exact;
  });
  const client = new PublicKanbanClient(loaded); const source = await client.getTask(input.taskId);
  const benchmark = source.fields['benchmark'] as { base_commit?: unknown; wiki_paths?: unknown } | undefined;
  if (typeof benchmark?.base_commit !== 'string') throw new Error('benchmark case has no full base commit');
  const wikis = await hashProjectWikis(Array.isArray(benchmark.wiki_paths) ? benchmark.wiki_paths.filter((item): item is string => typeof item === 'string') : [], { projectRoot: loaded.projectRoot });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-plan-'));
  try {
    const repository = path.join(temporary, 'snapshot');
    const snapshot = await buildSnapshot({ sourceRepository: loaded.projectRoot, baseCommit: benchmark.base_commit, destination: repository,
      excludedPaths: ['.juno_task', 'juno-benchmark/node_modules', 'juno-benchmark/dist'] });
    return planExperiment(client, { taskId: input.taskId, models, modelSelectors, attempts: input.attempts,
      snapshotHash: snapshot.content_identity, wikiHashes: Object.fromEntries(wikis.map((wiki) => [wiki.path, wiki.sha256])),
      toolPolicyHash: canonicalHash({ schema_version: 'juno_benchmark_tool_policy.v1', canonical_routing: 'absent' }),
      budgetHash: canonicalHash({ schema_version: 'juno_benchmark_budget.v1', timeout_ms: 1_800_000 }),
      packageVersion: PACKAGE_VERSION, junoVersion: await discoverJunoVersion(loaded.projectRoot),
      ...(input.aggregateMaxUsd === undefined ? {} : { aggregateMaxUsd: input.aggregateMaxUsd }) });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function createWorkflowPlanFromProject(input: {
  cwd: string; configPath?: string; workflowPath: string; policyPath: string; models: readonly string[]; attempts: number;
  variables?: Readonly<Record<string, string | number | boolean | null>>; selectedStepIds?: readonly string[];
}): Promise<WorkflowExecutionPlan> {
  const loaded = await loadConfig({ cwd: input.cwd, ...(input.configPath === undefined ? {} : { configPath: input.configPath }) });
  return planWorkflowFromProject({ projectRoot: loaded.projectRoot, repositoryId: loaded.config.repository_id,
    workflowPath: input.workflowPath, policyPath: input.policyPath, models: input.models, modelAliases: loaded.config.model_aliases,
    attempts: input.attempts, ...(input.variables === undefined ? {} : { variables: input.variables }),
    ...(input.selectedStepIds === undefined ? {} : { selectedStepIds: input.selectedStepIds }) });
}

export async function discoverJunoVersion(projectRoot: string): Promise<string> {
  const packagePath = path.join(projectRoot, 'juno-code', 'package.json');
  try { const value = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown }; if (typeof value.version === 'string') return value.version; }
  catch { /* installed CLI-only project */ }
  const explicit = process.env['YYLO_BENCHMARK_JUNO_VERSION'];
  if (explicit === undefined || explicit.trim() === '') throw new Error('cannot determine YYLO version; set YYLO_BENCHMARK_JUNO_VERSION');
  return explicit.trim();
}
