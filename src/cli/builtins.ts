import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { lintBenchmarkCase } from '../case/lint.js';
import { canonicalJson } from '../contracts/canonical.js';
import { CONFIG_FILENAME, CONFIG_SCHEMA_VERSION, loadConfig } from '../config/index.js';
import { PublicKanbanClient } from '../kanban/client.js';
import { doctorExperiment } from '../doctor/index.js';
import { createJunoRunner, readExecutionPlan, regradeExperiment, runExperiment, writeExecutionPlan } from '../execution/index.js';
import { createSnapshotPreparer } from '../execution/prepare.js';
import { createPlanFromProject } from '../planning/cli.js';
import { ImmutableArtifactRegistry } from '../registry/index.js';
import { generateLongitudinalReport } from '../reporting/index.js';
import { createJunoInvestigationAgent, investigateRetainedEvidence } from '../investigation/index.js';
import { authenticatedLauncherOptionsFromEnvironment, createAuthenticatedJunoRunner } from '../auth/index.js';
import { createCommandGrader } from '../grading/index.js';
import { installBenchmarkWikis } from '../wiki/index.js';
import { generateReleaseReadinessReceipt } from '../release-readiness/index.js';
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

function privateRegistry(): ImmutableArtifactRegistry {
  const root = process.env['JUNO_BENCHMARK_REGISTRY']?.trim();
  if (root === undefined || root === '') throw new Error('JUNO_BENCHMARK_REGISTRY must select the private artifact registry');
  return new ImmutableArtifactRegistry(root);
}

const plan = definition(['plan'], 'Create a deterministic execution plan', 'control-plane', true, (command, context) => {
  command.requiredOption('--task <task-id>').requiredOption('--models <models>').option('--attempts <count>', 'Attempts per model', '1').option('--output <path>').option('--dry-run', 'Explicitly affirm read-only planning').action(async (options: { task: string; models: string; attempts: string; output?: string }) => {
    const attempts = Number(options.attempts); const models = options.models.split(',').map((item) => item.trim()).filter(Boolean);
    const result = await createPlanFromProject({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }), taskId: options.task, models, attempts });
    if (options.output !== undefined) await writeExecutionPlan(path.resolve(context.cwd, options.output), result);
    context.writeStdout(`${canonicalJson(result)}\n`);
  });
});

const run = definition(['run'], 'Execute an immutable plan', 'execution', true, (command, context) => {
  command.requiredOption('--plan <path>').option('--no-record').option('--non-canonical-scope <scope>').action(async (options: { plan: string; record: boolean; nonCanonicalScope?: string }) => {
    const loaded = await loadConfig({ cwd: context.cwd, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
    const executionPlan = await readExecutionPlan(path.resolve(context.cwd, options.plan)); const client = new PublicKanbanClient(loaded); const registry = privateRegistry();
    const workRoot = process.env['JUNO_BENCHMARK_WORK_ROOT']?.trim() || path.join(registry.root, 'work'); await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const policy = options.record === false ? { noRecord: true as const, nonCanonicalScope: options.nonCanonicalScope as 'fixture' | 'local' } : {};
    const authenticated = authenticatedLauncherOptionsFromEnvironment();
    const runner = authenticated === null ? createJunoRunner() : createAuthenticatedJunoRunner(authenticated);
    const profileName = executionPlan.case.case_ref.grader_profile;
    const profile = loaded.config.grader_profiles[profileName];
    const grader = profile === undefined ? undefined : createCommandGrader({ executable: profile.executable, arguments: profile.arguments,
      graderId: profile.grader_id, graderVersion: profile.grader_version, sha256: profile.sha256 as `sha256:${string}`, cwd: loaded.projectRoot });
    const result = await runExperiment({ client, registry, plan: executionPlan, prepareAttempt: createSnapshotPreparer({ projectRoot: loaded.projectRoot, workRoot, plan: executionPlan, client }), runner, grader, recordPolicy: policy });
    context.writeStdout(`${canonicalJson(result)}\n`);
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
    const forbidden = Object.entries(process.env).filter(([key, value]) => value !== undefined && /(?:TOKEN|SECRET|PASSWORD|AUTH|REGISTRY|JUNO_BENCHMARK_(?:WORK_ROOT|REGISTRY)|^(?:HOME|XDG_))/u.test(key))
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
  plan,
  run,
  regrade,
  doctor,
  report,
  investigate,
  releaseReadiness,
]);

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of BUILTIN_COMMANDS) registry.registerBuiltin(command);
}
