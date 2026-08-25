import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Option, type Command } from 'commander';
import { lintBenchmarkCase } from '../case/lint.js';
import { canonicalJson } from '../contracts/canonical.js';
import { CONFIG_FILENAME, CONFIG_SCHEMA_VERSION, loadConfig } from '../config/index.js';
import { PublicKanbanClient } from '../kanban/client.js';
import { doctorExperiment } from '../doctor/index.js';
import { createJunoRunner, readExecutionPlan, regradeExperiment, runExperiment, writeExecutionPlan } from '../execution/index.js';
import { createSnapshotPreparer } from '../execution/prepare.js';
import { createPlanFromProject, createWorkflowPlanFromProject } from '../planning/cli.js';
import { parseBenchmarkPlan, TaskExecutionAuthorizationSchema, type BenchmarkPlan } from '../planning/index.js';
import { PersistentTypedResourceLocks } from '../execution/resource-lock.js';
import { ImmutableArtifactRegistry } from '../registry/index.js';
import { createReviewedWorkflowBoundary, executeWorkflowPlan, workflowBoundaryOptionsFromEnvironment } from '../workflow/runtime.js';
import { readWorkflowEvidenceReceipts, rejudgeRetainedWorkflowStep, storeWorkflowExperimentReport } from '../workflow/evidence.js';
import { generateLongitudinalReport } from '../reporting/index.js';
import { createJunoInvestigationAgent, investigateRetainedEvidence } from '../investigation/index.js';
import { authenticatedLauncherOptionsFromEnvironment, createAuthenticatedJunoRunner } from '../auth/index.js';
import { createCommandGrader } from '../grading/index.js';
import { installBenchmarkWikis } from '../wiki/index.js';
import { generateReleaseReadinessReceipt } from '../release-readiness/index.js';
import { generateBoundaryReadiness, installReviewedBoundary, BOUNDARY_SUPPORTED_PROVIDERS, loadBoundarySetup } from '../boundary/index.js';
import { discoverJunoVersion } from '../planning/cli.js';
import {
  COMMAND_API_VERSION,
  type CommandContext,
  type CommandDefinition,
  type CommandPhase,
  type CommandRegistry,
} from './registry.js';

function definition(
  commandPath: readonly [string, ...string[]],
  description: string,
  phase: CommandPhase,
  available: boolean,
  configure: (command: Command, context: CommandContext) => void,
): CommandDefinition {
  return { api_version: COMMAND_API_VERSION, path: commandPath, description, phase, available, configure };
}

const init = definition(['init'], 'Initialize benchmark configuration and managed guidance', 'foundation', true, (command, context) => {
  command.option('--stdout', 'Print configuration without writing it').action(async (options: { stdout?: boolean }) => {
    const contents = `${canonicalJson({
      schema_version: CONFIG_SCHEMA_VERSION,
      repository_id: 'root',
      kanban: { arguments: [] },
      model_aliases: {},
    })}\n`;
    if (options.stdout === true) {
      context.writeStdout(contents);
      return;
    }
    const destination = path.join(context.cwd, CONFIG_FILENAME);
    await writeFile(destination, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await installBenchmarkWikis({ projectRoot: context.cwd });
    context.writeStdout(`${destination}\n`);
  });
});

const caseLint = definition(['case', 'lint'], 'Validate an explicitly opted-in Kanban task', 'foundation', true, (command, context) => {
  command.argument('<task-id>').action(async (taskId: string) => {
    const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
    const task = await new PublicKanbanClient(loaded).getTask(taskId);
    context.writeStdout(`${canonicalJson(lintBenchmarkCase(task))}\n`);
  });
});

const setup = definition(['setup'], 'Install the reviewed hash-pinned workflow boundary and bind the private registry', 'foundation', true, (command, context) => {
  command.option('--providers <names>', `Comma-separated boundary providers (default: ${BOUNDARY_SUPPORTED_PROVIDERS.join(',')})`)
    .option('--synthetic', 'Record synthetic transport intent for installed-CLI acceptance without credentials')
    .action(async (options: { providers?: string; synthetic?: boolean }) => {
      const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
      const providers = (options.providers === undefined ? [...BOUNDARY_SUPPORTED_PROVIDERS] : options.providers.split(',').map((item) => item.trim()).filter(Boolean));
      const receipt = await installReviewedBoundary({ projectRoot: loaded.projectRoot, providers, synthetic: options.synthetic === true });
      context.writeStdout(`${canonicalJson(receipt)}\n`);
    });
});

const readiness = definition(['readiness'], 'Emit a retained zero-dispatch boundary readiness receipt for exact models', 'control-plane', true, (command, context) => {
  command.requiredOption('--models <selectors>', 'Comma-separated model selectors, resolved through model_aliases like planning')
    .action(async (options: { models: string }) => {
      const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
      const selections = options.models.split(',').map((item) => item.trim()).filter(Boolean).map((selector) => {
        const exact = selector.startsWith(':') ? loaded.config.model_aliases[selector] : selector;
        if (exact === undefined) throw new Error(`model alias ${selector} has no exact binding in model_aliases`);
        if (!/^[^:/\s\x00-\x1f\x7f]+\/[^:/\s\x00-\x1f\x7f]+$/u.test(exact)) throw new Error(`model ${selector} does not resolve to an exact provider/model identity`);
        const separator = exact.indexOf('/');
        return { selector, model: exact, provider: exact.slice(0, separator) };
      });
      if (selections.length === 0) throw new Error('at least one model selector is required');
      if (new Set(selections.map((item) => item.model)).size !== selections.length) throw new Error('model selectors must resolve to distinct exact models');
      const executable = process.env['YYLO_BENCHMARK_JUNO_EXECUTABLE']?.trim() || 'yy';
      const junoVersion = await discoverJunoVersion(loaded.projectRoot);
      const { receipt } = await generateBoundaryReadiness({ projectRoot: loaded.projectRoot, models: selections, junoVersion, junoExecutable: executable });
      context.writeStdout(`${canonicalJson(receipt)}\n`);
    });
});

function privateRegistry(): ImmutableArtifactRegistry {
  const root = process.env['YYLO_BENCHMARK_REGISTRY']?.trim();
  if (root === undefined || root === '') throw new Error('YYLO_BENCHMARK_REGISTRY must select the private artifact registry');
  return new ImmutableArtifactRegistry(root);
}

function collect(value: string, previous: string[]): string[] { return [...previous, value]; }
async function readJson(pathname: string, label: string): Promise<unknown> {
  try { return JSON.parse(await readFile(pathname, 'utf8')) as unknown; }
  catch (error) { throw new Error(`cannot read ${label} ${pathname}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function readBenchmarkPlan(planPath: string): Promise<BenchmarkPlan> {
  const value = await readJson(planPath, 'benchmark plan');
  try { return parseBenchmarkPlan(value); }
  catch (error) { throw new Error(`malformed benchmark plan ${planPath}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function readTaskAuthorization(authorizationPath: string | undefined, context: CommandContext) {
  if (authorizationPath === undefined) return undefined;
  const absolute = path.resolve(context.cwd, authorizationPath);
  try { return TaskExecutionAuthorizationSchema.parse(await readJson(absolute, 'task authorization')); }
  catch (error) { throw new Error(`malformed task authorization ${absolute}: ${error instanceof Error ? error.message : String(error)}`); }
}
function workflowStorage(context: CommandContext): { registry: ImmutableArtifactRegistry; locks: PersistentTypedResourceLocks } {
  const root = process.env['YYLO_BENCHMARK_REGISTRY']?.trim() || path.join(context.cwd, '.juno_task', 'artifacts', 'yylo-benchmark');
  return { registry: new ImmutableArtifactRegistry(root), locks: new PersistentTypedResourceLocks({ root: path.join(root, 'locks') }) };
}
async function workflowBoundary(context: CommandContext) {
  const options = workflowBoundaryOptionsFromEnvironment();
  if (options === null) throw new Error('live workflow execution requires YYLO_BENCHMARK_WORKFLOW_BOUNDARY and YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256');
  // When the reviewed module is the one this project installed, the setup
  // record owns transport selection so synthetic acceptance can never be
  // mistaken for live provider evidence and vice versa.
  const setup = await loadBoundarySetup(context.cwd).catch(() => null);
  if (setup !== null && setup.boundary.path === options.module) {
    const ambient = process.env['YYLO_BENCHMARK_BOUNDARY_SYNTHETIC'] === '1';
    if (setup.synthetic && !ambient) process.env['YYLO_BENCHMARK_BOUNDARY_SYNTHETIC'] = '1';
    if (!setup.synthetic && ambient) throw new Error('synthetic transport is ambient but the setup record binds live transport; rerun setup --synthetic explicitly');
  }
  return createReviewedWorkflowBoundary(options);
}
function variables(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`workflow variable must use key=value syntax: ${value}`);
    const key = value.slice(0, separator); if (result[key] !== undefined) throw new Error(`duplicate workflow variable: ${key}`);
    result[key] = value.slice(separator + 1);
  }
  return result;
}
const plan = definition(['plan'], 'Create a deterministic execution plan', 'control-plane', true, (command, context) => {
  command.addOption(new Option('--task <task-id>', 'Plan a legacy Kanban task case').conflicts('workflow'))
    .addOption(new Option('--workflow <path>', 'Plan a tracked Workflow Runner YAML').conflicts('task'))
    .requiredOption('--models <models>').option('--steps-file <path>', 'Hash-bound workflow benchmark policy sidecar')
    .option('--steps <ids>', 'Comma-separated stable workflow step IDs').option('--var <key=value>', 'Bind a workflow variable', collect, [])
    .option('--max-usd <amount>', 'Immutable aggregate spend ceiling in USD (default: 20)')
    .option('--attempts <count>', 'Attempts per model', '1').option('--output <path>').option('--dry-run', 'Explicitly affirm read-only planning')
    .action(async (options: { task?: string; workflow?: string; models: string; stepsFile?: string; steps?: string; var: string[]; maxUsd?: string; attempts: string; output?: string }) => {
      if ((options.task === undefined) === (options.workflow === undefined)) throw new Error('exactly one of --task or --workflow is required');
      if (options.workflow !== undefined && options.maxUsd !== undefined) throw new Error('--max-usd applies only to legacy task-case plans; workflow cost is best-effort evidence');
      const attempts = Number(options.attempts); const models = options.models.split(',').map((item) => item.trim()).filter(Boolean);
      const common = { cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }), models, attempts };
      const result = options.task !== undefined
        ? await createPlanFromProject({ ...common, taskId: options.task, ...(options.maxUsd === undefined ? {} : { aggregateMaxUsd: Number(options.maxUsd) }) })
        : await createWorkflowPlanFromProject({ ...common, workflowPath: options.workflow!,
          policyPath: options.stepsFile ?? (() => { throw new Error('--steps-file is required with --workflow'); })(),
          variables: variables(options.var), ...(options.steps === undefined ? {} : { selectedStepIds: options.steps.split(',').map((item) => item.trim()).filter(Boolean) }) });
      if (options.output !== undefined) {
        const destination = path.resolve(context.cwd, options.output);
        if (result.schema_version === 'juno_benchmark_plan.v1') await writeExecutionPlan(destination, result);
        else await writeFile(destination, `${canonicalJson(result)}\n`, { flag: 'wx', mode: 0o600 });
      }
      context.writeStdout(`${canonicalJson(result)}\n`);
    });
});

const run = definition(['run'], 'Execute an immutable task or workflow plan (workflow --dry-run never dispatches)', 'execution', true, (command, context) => {
  command.requiredOption('--plan <path>').option('--steps-file <path>', 'Workflow policy sidecar used for immediate hash verification')
    .option('--authorization <path>', 'Explicit plan-bound execution authorization').option('--dry-run', 'Verify and render a workflow plan with zero dispatch')
    .option('--no-record').option('--non-canonical-scope <scope>').action(async (options: { plan: string; stepsFile?: string; authorization?: string; dryRun?: boolean; record: boolean; nonCanonicalScope?: string }) => {
      const absolutePlan = path.resolve(context.cwd, options.plan); const benchmarkPlan = await readBenchmarkPlan(absolutePlan);
      if (benchmarkPlan.schema_version === 'juno_benchmark_workflow_plan.v2') {
        if (options.record === false || options.nonCanonicalScope !== undefined) throw new Error('--no-record and --non-canonical-scope apply only to task-case plans');
        if (options.stepsFile === undefined) throw new Error('--steps-file is required for workflow run binding verification');
        if (options.authorization !== undefined) throw new Error('workflow execution no longer accepts spend authorization; cost is best-effort evidence');
        const storage = workflowStorage(context);
        const boundary = options.dryRun === true ? undefined : await workflowBoundary(context);
        const result = await executeWorkflowPlan({ plan: benchmarkPlan, projectRoot: context.cwd, policyPath: options.stepsFile,
          registry: storage.registry, locks: storage.locks,
          ...(boundary === undefined ? { dryRun: true as const } : { dispatcher: boundary.dispatcher, judge: boundary.judge, boundaryIdentity: boundary.identity }) });
        context.writeStdout(`${canonicalJson(result)}\n`); return;
      }
      if (options.dryRun === true || options.stepsFile !== undefined) throw new Error('workflow options cannot be combined with a task-case plan');
      const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
      const executionPlan = await readExecutionPlan(absolutePlan); const client = new PublicKanbanClient(loaded); const registry = privateRegistry();
      const locks = new PersistentTypedResourceLocks({ root: path.join(registry.root, 'locks') });
      const workRoot = process.env['YYLO_BENCHMARK_WORK_ROOT']?.trim() || path.join(registry.root, 'work'); await mkdir(workRoot, { recursive: true, mode: 0o700 });
      const policy = options.record === false ? { noRecord: true as const, nonCanonicalScope: options.nonCanonicalScope as 'fixture' | 'local' } : {};
      const authenticated = authenticatedLauncherOptionsFromEnvironment();
      const runner = authenticated === null ? createJunoRunner() : createAuthenticatedJunoRunner(authenticated);
      const authorization = await readTaskAuthorization(options.authorization, context);
      const profileName = executionPlan.case.case_ref.grader_profile; const profile = loaded.config.grader_profiles[profileName];
      const grader = profile === undefined ? undefined : createCommandGrader({ executable: profile.executable, arguments: profile.arguments,
        graderId: profile.grader_id, graderVersion: profile.grader_version, sha256: profile.sha256 as `sha256:${string}`, cwd: loaded.projectRoot });
      const result = await runExperiment({ client, registry, plan: executionPlan, prepareAttempt: createSnapshotPreparer({ projectRoot: loaded.projectRoot, workRoot, plan: executionPlan, client }), runner, grader,
        ...(authorization === undefined ? {} : { authorization }), recordPolicy: policy, locks });
      context.writeStdout(`${canonicalJson(result)}\n`);
    });
});

const recover = definition(['recover'], 'Recover a workflow plan from durable intent without blind redispatch', 'execution', true, (command, context) => {
  command.requiredOption('--plan <path>').requiredOption('--steps-file <path>')
    .option('--authorization <path>', 'Explicit plan-bound workflow execution authorization')
    .option('--dry-run', 'Verify recovery bindings and order with zero dispatch')
    .action(async (options: { plan: string; stepsFile: string; authorization?: string; dryRun?: boolean }) => {
      const benchmarkPlan = await readBenchmarkPlan(path.resolve(context.cwd, options.plan));
      if (benchmarkPlan.schema_version !== 'juno_benchmark_workflow_plan.v2') throw new Error('recover supports workflow plans only; task-case recovery remains automatic in run');
      const storage = workflowStorage(context); const boundary = options.dryRun === true ? undefined : await workflowBoundary(context);
      if (options.authorization !== undefined) throw new Error('workflow recovery no longer accepts spend authorization; cost is best-effort evidence');
      const result = await executeWorkflowPlan({ plan: benchmarkPlan, projectRoot: context.cwd,
        policyPath: options.stepsFile, registry: storage.registry, locks: storage.locks,
        ...(boundary === undefined ? { dryRun: true as const } : { dispatcher: boundary.dispatcher, judge: boundary.judge, boundaryIdentity: boundary.identity }) });
      context.writeStdout(`${canonicalJson({ operation: 'recover', ...result })}\n`);
    });
});

const rejudgeWorkflow = definition(['rejudge'], 'Rejudge retained workflow truth without candidate dispatch', 'execution', true, (command, context) => {
  command.requiredOption('--plan <path>').requiredOption('--steps-file <path>', 'Workflow policy sidecar used for immediate hash verification')
    .option('--judge <selector>', 'Requested governed judge selector')
    .option('--dry-run', 'Verify immutable rejudge inputs with zero judge or candidate dispatch')
    .action(async (options: { plan: string; stepsFile: string; judge?: string; dryRun?: boolean }) => {
      const benchmarkPlan = await readBenchmarkPlan(path.resolve(context.cwd, options.plan));
      if (benchmarkPlan.schema_version !== 'juno_benchmark_workflow_plan.v2') throw new Error('rejudge supports workflow plans only; use regrade for task-case plans');
      const storage = workflowStorage(context); const verified = await executeWorkflowPlan({ plan: benchmarkPlan, projectRoot: context.cwd,
        policyPath: options.stepsFile, registry: storage.registry, locks: storage.locks, dryRun: true });
      if (!('immutable_hashes' in verified)) throw new Error('workflow rejudge dry-run unexpectedly entered execution');
      const requestedJudge = options.judge ?? benchmarkPlan.policy.judge.model;
      const resolvedJudge = requestedJudge === benchmarkPlan.policy.judge.model ? requestedJudge
        : Object.entries(benchmarkPlan.model_selectors).find(([, selector]) => selector === requestedJudge)?.[0];
      if (resolvedJudge !== benchmarkPlan.policy.judge.model) throw new Error('requested workflow judge does not match the immutable governed judge policy');
      if (options.dryRun === true) {
        context.writeStdout(`${canonicalJson({ schema_version: 'juno_benchmark_workflow_rejudge_dry_run.v1', operation: 'rejudge',
          plan_id: benchmarkPlan.plan_id, candidate_dispatch_count: 0, judge_dispatch_count: 0,
          requested_judge: requestedJudge, retained_candidate_receipts_expected: benchmarkPlan.execution_order.length,
          policy_semantics_sha256: benchmarkPlan.policy_semantics_sha256, immutable_hashes: verified.immutable_hashes })}\n`); return;
      }
      const boundary = await workflowBoundary(context); const experimentId = `workflow-${benchmarkPlan.plan_id.slice(7)}`;
      const receipts = await readWorkflowEvidenceReceipts(storage.registry, experimentId);
      if (receipts.length !== benchmarkPlan.execution_order.length) throw new Error('workflow rejudge requires a complete retained receipt set');
      const judgements = [];
      for (const receipt of receipts) {
        judgements.push(await rejudgeRetainedWorkflowStep({ registry: storage.registry, experimentId,
          receipt, trustedReceiptHash: receipt.receipt_hash, expectedPolicySemanticsHash: benchmarkPlan.policy_semantics_sha256 as `sha256:${string}`,
          judge: benchmarkPlan.policy.judge, runner: boundary.judge, locks: storage.locks }));
      }
      const report = await storeWorkflowExperimentReport(storage.registry, benchmarkPlan);
      context.writeStdout(`${canonicalJson({ schema_version: 'juno_benchmark_workflow_rejudge.v1', operation: 'rejudge',
        plan_id: benchmarkPlan.plan_id, candidate_dispatch_count: 0, judge_dispatch_count: judgements.length,
        requested_judge: requestedJudge, boundary: boundary.identity, judgements, report })}\n`);
    });
});

const regrade = definition(['regrade'], 'Regrade retained candidate evidence without candidate execution', 'execution', true, (command, context) => {
  command.requiredOption('--plan <path>').action(async (options: { plan: string }) => {
    const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
    const executionPlan = await readExecutionPlan(path.resolve(context.cwd, options.plan));
    const profileName = executionPlan.case.case_ref.grader_profile; const profile = loaded.config.grader_profiles[profileName];
    const grader = profile === undefined ? undefined : createCommandGrader({ executable: profile.executable, arguments: profile.arguments,
      graderId: profile.grader_id, graderVersion: profile.grader_version, sha256: profile.sha256 as `sha256:${string}`, cwd: loaded.projectRoot });
    const result = await regradeExperiment({ registry: privateRegistry(), plan: executionPlan, grader, client: new PublicKanbanClient(loaded) });
    context.writeStdout(`${canonicalJson(result)}\n`);
  });
});

const doctor = definition(['doctor'], 'Verify retained experiment evidence', 'execution', true, (command, context) => {
  command.argument('<experiment-task-id>').action(async (taskId: string) => {
    const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
    const result = await doctorExperiment(new PublicKanbanClient(loaded), privateRegistry(), taskId);
    context.writeStdout(`${canonicalJson(result)}\n`);
  });
});

const report = definition(['report'], 'Build a longitudinal case report', 'longitudinal', true, (command, context) => {
  command.requiredOption('--task <task-id>').action(async (options: { task: string }) => {
    const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
    const result = await generateLongitudinalReport({ client: new PublicKanbanClient(loaded), registry: privateRegistry(), taskId: options.task });
    context.writeStdout(`${canonicalJson(result)}\n`);
  });
});

const releaseReadiness = definition(['release-readiness'], 'Generate a deterministic offline release-readiness receipt', 'longitudinal', true, (command, context) => {
  command.requiredOption('--input <path>', 'Path to measured path-free artifact identities').action(async (options: { input: string }) => {
    const raw = JSON.parse(await readFile(path.resolve(context.cwd, options.input), 'utf8')) as unknown;
    const forbidden = Object.entries(process.env).filter(([key, value]) => value !== undefined && /(?:TOKEN|SECRET|PASSWORD|AUTH|REGISTRY|YYLO_BENCHMARK_(?:WORK_ROOT|REGISTRY)|^(?:HOME|XDG_))/u.test(key))
      .map(([, value]) => value as string);
    context.writeStdout(`${canonicalJson(generateReleaseReadinessReceipt(raw, { forbiddenValues: forbidden }))}\n`);
  });
});

const investigate = definition(['investigate'], 'Investigate bounded retained evidence', 'longitudinal', true, (command, context) => {
  command.requiredOption('--task <task-id>').argument('<question>').action(async (question: string, options: { task: string }) => {
    const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
    const result = await investigateRetainedEvidence({ client: new PublicKanbanClient(loaded), registry: privateRegistry(), taskId: options.task, question, agent: createJunoInvestigationAgent() });
    context.writeStdout(`${canonicalJson(result)}\n`);
  });
});

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  init,
  caseLint,
  setup,
  readiness,
  plan,
  run,
  recover,
  rejudgeWorkflow,
  regrade,
  doctor,
  report,
  investigate,
  releaseReadiness,
]);

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of BUILTIN_COMMANDS) registry.registerBuiltin(command);
}
