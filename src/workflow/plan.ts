import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isAlias, parseDocument, stringify, visit } from 'yaml';
import { z } from 'zod';
import { canonicalHash, sha256Hex, type JsonValue } from '../contracts/canonical.js';

export const WORKFLOW_PLAN_SCHEMA_VERSION = 'juno_benchmark_workflow_plan.v1' as const;
export const WORKFLOW_POLICY_SCHEMA_VERSION = 'juno_benchmark_workflow_policy.v1' as const;
export const WORKFLOW_COMPILER_VERSION = 'juno_benchmark_workflow_overlay.v1' as const;
export const WORKFLOW_RUNNER_SCHEMA_VERSION = 'juno_workflow_runner.v2' as const;

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const exactModel = z.string().regex(/^[^:/\s]+\/[^:/\s]+$/u);
const stepId = z.string().regex(/^[A-Za-z0-9_.-]+$/u);
const jsonScalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const resource = z.object({
  type: z.enum(['filesystem', 'network', 'credential', 'shared_resource', 'production']),
  id: nonEmpty,
  access: z.enum(['read', 'write', 'exclusive']),
}).strict();

export const WorkflowStepPolicySchema = z.object({
  step_id: stepId,
  scoring_id: nonEmpty,
  side_effect: z.enum(['none', 'local_filesystem', 'network', 'paid', 'production']),
  resources: z.array(resource).default([]),
  limits: z.object({ timeout_ms: z.number().int().positive(), max_usd: z.number().finite().nonnegative() }).strict(),
  authorization: z.enum(['none', 'spend', 'production_and_spend']),
  recovery: z.enum(['manual', 'retry_safe']),
  redaction: z.object({ patterns: z.array(nonEmpty).default([]), retain_prompt: z.boolean().default(false) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.resources.some((item) => item.type === 'production') && value.side_effect !== 'production') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resources'], message: 'production resources require production side-effect classification' });
  }
});

export const WorkflowPolicySchema = z.object({
  schema_version: z.literal(WORKFLOW_POLICY_SCHEMA_VERSION),
  judge: z.object({ judge_id: nonEmpty, judge_version: nonEmpty, model: nonEmpty, rubric_hash: sha256 }).strict(),
  authorization: z.object({ authorization_id: nonEmpty, production: z.boolean(), spend: z.boolean() }).strict(),
  recovery: z.object({ ambiguous_effect: z.literal('manual'), max_recovery_attempts: z.number().int().nonnegative() }).strict(),
  redaction: z.object({ secret_patterns: z.array(nonEmpty).default([]), retain_prompts: z.boolean().default(false) }).strict(),
  estimates: z.object({ models: z.array(z.object({
    model: exactModel, candidate_usd: z.number().finite().nonnegative(), judge_usd: z.number().finite().nonnegative(), runtime_ms: z.number().int().nonnegative(),
  }).strict()).min(1) }).strict().optional(),
  steps: z.array(WorkflowStepPolicySchema).min(1),
}).strict().superRefine((value, context) => {
  const ids = value.steps.map((item) => item.step_id);
  const scoring = value.steps.map((item) => item.scoring_id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'step policies must have unique step_id values' });
  if (new Set(scoring).size !== scoring.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'scoring_id values must be unique' });
  if (!value.authorization.production && value.steps.some((item) => item.authorization === 'production_and_spend')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['authorization', 'production'], message: 'step production authorization exceeds the plan authorization' });
  }
  const estimatedModels = value.estimates?.models.map((item) => item.model) ?? [];
  if (new Set(estimatedModels).size !== estimatedModels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['estimates', 'models'], message: 'estimated model identities must be unique' });
  }
});

const sourceIdentity = z.object({
  repository_id: nonEmpty,
  source_ref: nonEmpty,
  source_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  workflow_path: nonEmpty,
  raw_sha256: sha256,
  semantics_sha256: sha256,
}).strict();
const compiledWorkflow = z.object({
  model: exactModel,
  selector: nonEmpty,
  provider: nonEmpty,
  model_name: nonEmpty,
  workflow_sha256: sha256,
  workflow_bytes_base64: nonEmpty,
  injected_step_ids: z.array(stepId),
}).strict();
export const WorkflowExecutionPlanObjectSchema = z.object({
  schema_version: z.literal(WORKFLOW_PLAN_SCHEMA_VERSION),
  plan_id: sha256,
  source: sourceIdentity,
  snapshot: z.object({ source_tree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u), identity: sha256 }).strict(),
  workflow_schema_version: z.literal(WORKFLOW_RUNNER_SCHEMA_VERSION),
  compiler_version: z.literal(WORKFLOW_COMPILER_VERSION),
  normalized_workflow: z.record(z.unknown()),
  variables: z.record(jsonScalar),
  variables_hash: sha256,
  selected_step_ids: z.array(stepId).min(1),
  execution_order: z.array(z.object({ model: exactModel, attempt: z.number().int().positive(), step_id: stepId }).strict()).min(1),
  attempts: z.number().int().positive(),
  models: z.array(exactModel).min(1),
  model_dispatch_step_ids: z.array(stepId),
  model_selectors: z.record(nonEmpty),
  workflow_model_policy: z.object({ config_path: nonEmpty, config_sha256: sha256.nullable(), workflow_models: z.array(nonEmpty), workflow_models_sha256: sha256 }).strict(),
  policy: WorkflowPolicySchema,
  policy_raw_sha256: sha256,
  policy_semantics_sha256: sha256,
  compiled_workflows: z.array(compiledWorkflow).min(1),
}).strict();
export const WorkflowExecutionPlanSchema = WorkflowExecutionPlanObjectSchema.superRefine((value, context) => {
  const issue = (path: (string | number)[], message: string): void => context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (new Set(value.selected_step_ids).size !== value.selected_step_ids.length) issue(['selected_step_ids'], 'selected step IDs must be unique');
  if (new Set(value.models).size !== value.models.length || value.compiled_workflows.length !== value.models.length) issue(['models'], 'models and compiled workflows must be unique and complete');
  if (canonicalHash(value.normalized_workflow) !== value.source.semantics_sha256) issue(['source', 'semantics_sha256'], 'normalized workflow hash does not match source semantics');
  if (canonicalHash({ repository_id: value.source.repository_id, source_commit: value.source.source_commit, source_tree: value.snapshot.source_tree }) !== value.snapshot.identity) issue(['snapshot', 'identity'], 'snapshot identity is invalid');
  if (canonicalHash(value.variables) !== value.variables_hash) issue(['variables_hash'], 'variables hash is invalid');
  if (canonicalHash(value.policy) !== value.policy_semantics_sha256) issue(['policy_semantics_sha256'], 'policy semantics hash is invalid');
  if (canonicalHash(value.workflow_model_policy.workflow_models) !== value.workflow_model_policy.workflow_models_sha256) issue(['workflow_model_policy'], 'workflowModels hash is invalid');
  if (Object.keys(value.model_selectors).length !== value.models.length || value.models.some((model) => value.model_selectors[model] === undefined)) issue(['model_selectors'], 'model selector bindings are incomplete');
  if (value.policy.estimates !== undefined && canonicalHash(value.policy.estimates.models.map((item) => item.model)) !== canonicalHash(value.models)) {
    issue(['policy', 'estimates'], 'model estimates must exactly match planned model order and identities');
  }
  value.compiled_workflows.forEach((compiled, index) => {
    if (compiled.model !== value.models[index] || compiled.selector !== value.model_selectors[compiled.model]) issue(['compiled_workflows', index], 'compiled workflow model/selector order is invalid');
    try {
      const bytes = Buffer.from(compiled.workflow_bytes_base64, 'base64');
      if (bytes.toString('base64') !== compiled.workflow_bytes_base64 || prefixedHash(bytes) !== compiled.workflow_sha256) issue(['compiled_workflows', index, 'workflow_sha256'], 'compiled workflow bytes/hash are invalid');
      parseWorkflowBytes(bytes);
    } catch (error) { issue(['compiled_workflows', index], `compiled workflow is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  });
  const expectedOrder = value.models.flatMap((model) => Array.from({ length: value.attempts }, (_, index) => value.selected_step_ids.map((id) => ({ model, attempt: index + 1, step_id: id })))).flat();
  if (canonicalHash(expectedOrder) !== canonicalHash(value.execution_order)) issue(['execution_order'], 'execution order does not match model/attempt/stable-step bindings');
  const policyIds = new Set(value.policy.steps.map((item) => item.step_id));
  if (value.selected_step_ids.some((id) => !policyIds.has(id))) issue(['policy', 'steps'], 'every selected step requires a policy and scoring identity');
  if (new Set(value.model_dispatch_step_ids).size !== value.model_dispatch_step_ids.length
      || value.model_dispatch_step_ids.some((id) => !value.selected_step_ids.includes(id))) {
    issue(['model_dispatch_step_ids'], 'model dispatch step IDs must be unique selected steps');
  }
  try {
    const normalizedSteps = value.normalized_workflow['steps'] as Array<Record<string, JsonValue>>;
    const expectedModelDispatchIds = value.selected_step_ids.filter((id) => commandSelection(
      normalizedSteps.find((item) => item['id'] === id)!['command'] ?? null, `workflow step ${id}`).canonical);
    if (canonicalHash(expectedModelDispatchIds) !== canonicalHash(value.model_dispatch_step_ids)) {
      issue(['model_dispatch_step_ids'], 'model dispatch classification does not match the bound workflow commands');
    }
  } catch (error) {
    issue(['model_dispatch_step_ids'], `model dispatch classification is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
});

export type WorkflowPolicy = z.infer<typeof WorkflowPolicySchema>;
export type WorkflowExecutionPlan = z.infer<typeof WorkflowExecutionPlanSchema>;
export interface ParsedWorkflow {
  readonly raw_bytes: Uint8Array;
  readonly raw_sha256: `sha256:${string}`;
  readonly semantics: Record<string, JsonValue>;
  readonly semantics_sha256: `sha256:${string}`;
  readonly schema_version: typeof WORKFLOW_RUNNER_SCHEMA_VERSION;
  readonly step_ids: readonly string[];
}

function prefixedHash(bytes: Uint8Array): `sha256:${string}` { return `sha256:${sha256Hex(bytes)}`; }
function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} contains a non-JSON value`);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item, `${label}.${key}`)]));
  }
  throw new Error(`${label} contains an unsupported ${typeof value} value`);
}

export function parseWorkflowBytes(rawBytes: Uint8Array): ParsedWorkflow {
  const text = Buffer.from(rawBytes).toString('utf8');
  if (Buffer.from(text, 'utf8').compare(Buffer.from(rawBytes)) !== 0) throw new Error('workflow must be valid UTF-8');
  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) throw new Error(`invalid workflow YAML: ${document.errors[0]!.message}`);
  if (document.warnings.length > 0) throw new Error(`unsupported workflow YAML: ${document.warnings[0]!.message}`);
  let alias = false; visit(document, { Node(_key, node) { if (isAlias(node)) alias = true; } });
  if (alias) throw new Error('workflow YAML aliases are unsupported because overlays must have unambiguous positions');
  const value = jsonValue(document.toJS({ maxAliasCount: 0 }), 'workflow');
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('workflow must be a mapping');
  const workflow = value as Record<string, JsonValue>;
  const declared = String(workflow['schema_version'] ?? '').trim();
  if (!['1', '1.0', 'v1', '2', '2.0', 'v2'].includes(declared)) throw new Error(`unsupported workflow schema_version: ${declared || '<missing>'}`);
  if (workflow['workflow_class'] === 'local_integration') throw new Error('local_integration workflows are unsupported for benchmarking');
  const steps = workflow['steps'];
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('workflow must define a non-empty steps list');
  const ids: string[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === null || Array.isArray(step) || typeof step !== 'object') throw new Error(`workflow step ${index + 1} must be a mapping`);
    const id = String((step as Record<string, JsonValue>)['id'] ?? '').trim();
    if (!/^[A-Za-z0-9_.-]+$/u.test(id)) throw new Error(`workflow step ${index + 1} has an invalid stable id`);
    if (ids.includes(id)) throw new Error(`duplicate workflow step id: ${id}`);
    ids.push(id);
    if ((step as Record<string, JsonValue>)['managed_agent'] !== undefined) throw new Error(`workflow step ${id} uses unsupported managed_agent construction`);
  }
  return Object.freeze({ raw_bytes: Buffer.from(rawBytes), raw_sha256: prefixedHash(rawBytes), semantics: workflow,
    semantics_sha256: canonicalHash(workflow), schema_version: WORKFLOW_RUNNER_SCHEMA_VERSION, step_ids: Object.freeze(ids) });
}

export function parseWorkflowPolicyBytes(rawBytes: Uint8Array): { readonly policy: WorkflowPolicy; readonly raw_sha256: `sha256:${string}`; readonly semantics_sha256: `sha256:${string}` } {
  const document = parseDocument(Buffer.from(rawBytes).toString('utf8'), { uniqueKeys: true, strict: true });
  if (document.errors.length > 0) throw new Error(`invalid workflow policy YAML: ${document.errors[0]!.message}`);
  let alias = false; visit(document, { Node(_key, node) { if (isAlias(node)) alias = true; } });
  if (alias) throw new Error('workflow policy YAML aliases are unsupported');
  const policy = WorkflowPolicySchema.parse(jsonValue(document.toJS({ maxAliasCount: 0 }), 'policy'));
  return Object.freeze({ policy, raw_sha256: prefixedHash(rawBytes), semantics_sha256: canonicalHash(policy) });
}

interface Selection { readonly selector: string; readonly exact: string; readonly provider: string; readonly modelName: string }
const ordinaryExecutables = new Set(['echo', 'printf']);
function commandSelection(command: JsonValue, context: string): { readonly canonical: boolean; readonly explicit: string | null; readonly piIndex: number | null } {
  if (!Array.isArray(command)) throw new Error(`${context} command must be an explicit argument array`);
  if (command.length === 0 || !command.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${context} command arrays must contain only non-empty strings`);
  }
  const parts = command as string[];
  if (parts.some((item) => /^(?:[A-Za-z_][A-Za-z0-9_]*=)?[^=]*(?:MODEL|PROVIDER|CONFIG|ADDITIONAL_ARGS)[^=]*=/iu.test(item))) throw new Error(`${context} contains a hidden model/config override channel`);
  const executable = parts[0]!;
  if (executable !== 'yy') {
    if (!ordinaryExecutables.has(executable)) {
      throw new Error(`${context} executable ${executable} is not an approved direct ordinary command or canonical yy pi`);
    }
    return { canonical: false, explicit: null, piIndex: null };
  }
  if (parts[1] !== 'pi') throw new Error(`${context} yy command must be the canonical yy pi argument array`);
  const piIndex = 1;
  const providers: string[] = []; const models: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const token = parts[index]!;
    if (token === '--') break;
    if (token === '--additional-args' || token.startsWith('--additional-args=') || token === '-c' || token === '--config' || token.startsWith('--config=') || /^-c.+/u.test(token)) throw new Error(`${context} contains an unsupported hidden override channel`);
    const kind = token === '--provider' ? providers : token === '-m' || token === '--model' ? models : null;
    if (kind !== null) {
      const value = parts[index + 1]; if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${context} has a missing selector value`);
      kind.push(value); index += 1; continue;
    }
    if (token.startsWith('--provider=')) providers.push(token.slice(11));
    if (token.startsWith('--model=')) models.push(token.slice(8));
    if (/^-m.+/u.test(token)) throw new Error(`${context} has a malformed model selector`);
  }
  if (providers.length > 1 || models.length > 1) throw new Error(`${context} has duplicate model/provider selectors`);
  if (providers.length === 1 && models.length === 0) throw new Error(`${context} explicit --provider requires explicit --model`);
  const provider = providers[0]; const model = models[0];
  if (provider !== undefined && (provider.includes('/') || provider.startsWith(':') || model!.includes('/') || model!.startsWith(':'))) throw new Error(`${context} has an ambiguous provider/model selector`);
  return { canonical: true, explicit: provider === undefined ? model ?? null : `${provider}/${model!}`, piIndex };
}

export function workflowStepRequiresModelDispatch(rawBytes: Uint8Array, stepId: string): boolean {
  const parsed = parseWorkflowBytes(rawBytes);
  const steps = parsed.semantics['steps'] as Array<Record<string, JsonValue>>;
  const step = steps.find((item) => String(item['id']) === stepId);
  if (step === undefined) throw new Error(`compiled workflow does not contain exact step ${stepId}`);
  return commandSelection(step['command'] ?? null, `workflow step ${stepId}`).canonical;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function compileWorkflowOverlay(parsed: ParsedWorkflow, selectedStepIds: readonly string[], selection: Selection, workflowModels: readonly string[]): z.infer<typeof compiledWorkflow> {
  if (!workflowModels.includes(selection.selector)) throw new Error(`model selector ${selection.selector} is not exactly allowlisted by workflowModels`);
  const workflow = clone(parsed.semantics); const steps = workflow['steps'] as Array<Record<string, JsonValue>>; const selected = new Set(selectedStepIds); const injected: string[] = [];
  for (const step of steps) {
    const id = String(step['id']); if (!selected.has(id)) continue;
    const parsedCommand = commandSelection(step['command'] ?? null, `workflow step ${id}`);
    if (!parsedCommand.canonical) continue;
    if (parsedCommand.explicit !== null && parsedCommand.explicit !== selection.selector) throw new Error(`workflow step ${id} selector ${parsedCommand.explicit} conflicts with experiment selector ${selection.selector}`);
    if (parsedCommand.explicit === null) {
      const command = step['command'] as string[]; command.splice(parsedCommand.piIndex! + 1, 0, '--model', selection.selector); injected.push(id);
    }
  }
  const bytes = Buffer.from(stringify(workflow, { lineWidth: 0, sortMapEntries: false }), 'utf8');
  // Re-parse generated bytes with the same schema and policy checks before binding them.
  const generated = parseWorkflowBytes(bytes);
  for (const step of (generated.semantics['steps'] as Array<Record<string, JsonValue>>)) {
    if (selected.has(String(step['id']))) commandSelection(step['command'] ?? null, `compiled workflow step ${String(step['id'])}`);
  }
  return Object.freeze({ model: selection.exact, selector: selection.selector, provider: selection.provider, model_name: selection.modelName,
    workflow_sha256: prefixedHash(bytes), workflow_bytes_base64: bytes.toString('base64'), injected_step_ids: injected });
}

function selectSteps(parsed: ParsedWorkflow, requested: readonly string[] | undefined): readonly string[] {
  const selected = requested === undefined || requested.length === 0 ? [...parsed.step_ids] : [...requested];
  if (new Set(selected).size !== selected.length) throw new Error('selected workflow step IDs must be unique');
  const positions = selected.map((id) => { const index = parsed.step_ids.indexOf(id); if (index < 0) throw new Error(`selected workflow step does not exist: ${id}`); return index; });
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) throw new Error('selected workflow steps must follow stable source order; positional drift is forbidden');
  return Object.freeze(selected);
}

function validatePolicyCoverage(parsed: ParsedWorkflow, selected: readonly string[], policy: WorkflowPolicy): void {
  const policies = new Map(policy.steps.map((item) => [item.step_id, item]));
  const steps = parsed.semantics['steps'] as Array<Record<string, JsonValue>>;
  for (const id of selected) {
    const step = steps.find((item) => item['id'] === id)!;
    const launch = commandSelection(step['command'] ?? null, `workflow step ${id}`);
    if (!policies.has(id)) {
      const reason = launch.canonical ? ' is consequential (credentialed/paid agent launch) and' : '';
      throw new Error(`workflow step ${id}${reason} requires policy with a stable scoring identity`);
    }
    const stepPolicy = policies.get(id)!;
    void stepPolicy; // Policy metadata remains bound, but cost availability never authorizes dispatch.
  }
  for (const id of policies.keys()) if (!parsed.step_ids.includes(id)) throw new Error(`workflow policy references unknown stable step ID: ${id}`);
}

const execFileAsync = promisify(execFile);
async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return stdout.trim();
}
export async function loadWorkflowModelPolicy(projectRoot: string): Promise<WorkflowExecutionPlan['workflow_model_policy']> {
  const configPath = path.join(projectRoot, '.juno_task', 'config.json'); let raw: Buffer | null = null;
  try { raw = await readFile(configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let models: string[] = [];
  if (raw !== null) {
    const value = JSON.parse(raw.toString('utf8')) as { workflowModels?: unknown };
    if (value.workflowModels !== undefined && (!Array.isArray(value.workflowModels) || value.workflowModels.some((item) => typeof item !== 'string' || item.trim() !== item || item === ''))) throw new Error('project workflowModels must be an array of non-empty, trimmed strings');
    models = (value.workflowModels ?? []) as string[];
    if (new Set(models).size !== models.length) throw new Error('project workflowModels entries must be unique');
  }
  return { config_path: '.juno_task/config.json', config_sha256: raw === null ? null : prefixedHash(raw), workflow_models: models, workflow_models_sha256: canonicalHash(models) };
}

export async function planWorkflowFromProject(input: {
  readonly projectRoot: string; readonly repositoryId: string; readonly workflowPath: string; readonly policyPath: string;
  readonly models: readonly string[]; readonly modelAliases: Readonly<Record<string, string>>; readonly attempts: number;
  readonly variables?: Readonly<Record<string, string | number | boolean | null>>; readonly selectedStepIds?: readonly string[];
}): Promise<WorkflowExecutionPlan> {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) throw new Error('attempts must be a positive safe integer');
  const root = path.resolve(input.projectRoot); const workflowPath = path.resolve(root, input.workflowPath); const policyPath = path.resolve(root, input.policyPath);
  for (const [label, candidate] of [['workflow', workflowPath], ['policy', policyPath]] as const) if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path must remain inside the project root`);
  const relative = path.relative(root, workflowPath).split(path.sep).join('/');
  await git(root, ['ls-files', '--error-unmatch', '--', relative]);
  const sourceCommit = await git(root, ['rev-parse', 'HEAD']); const sourceRef = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => `detached@${sourceCommit}`);
  const sourceTree = await git(root, ['rev-parse', `${sourceCommit}^{tree}`]);
  const [raw, policyRaw, committed] = await Promise.all([readFile(workflowPath), readFile(policyPath), execFileAsync('git', ['-C', root, 'show', `${sourceCommit}:${relative}`], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }).then((result) => Buffer.from(result.stdout))]);
  if (!raw.equals(committed)) throw new Error('workflow raw bytes differ from the bound source commit');
  const parsed = parseWorkflowBytes(raw); const policyBinding = parseWorkflowPolicyBytes(policyRaw); const selected = selectSteps(parsed, input.selectedStepIds);
  validatePolicyCoverage(parsed, selected, policyBinding.policy);
  const seen = new Set<string>(); const selections: Selection[] = input.models.map((selector) => {
    const exact = selector.startsWith(':') ? input.modelAliases[selector] : selector;
    if (exact === undefined) throw new Error(`model alias ${selector} has no exact binding in model_aliases`);
    if (!/^[^:/\s]+\/[^:/\s]+$/u.test(exact)) throw new Error(`model ${selector} does not resolve to an exact provider/model identity`);
    if (seen.has(exact)) throw new Error(`multiple selectors resolve to the same exact model: ${exact}`); seen.add(exact);
    const separator = exact.indexOf('/'); return { selector, exact, provider: exact.slice(0, separator), modelName: exact.slice(separator + 1) };
  });
  if (selections.length === 0) throw new Error('at least one model is required');
  const modelPolicy = await loadWorkflowModelPolicy(root);
  const compiled = selections.map((selection) => compileWorkflowOverlay(parsed, selected, selection, modelPolicy.workflow_models));
  const variables = Object.fromEntries(Object.entries(input.variables ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const selectedSteps = parsed.semantics['steps'] as Array<Record<string, JsonValue>>;
  const modelDispatchStepIds = selected.filter((id) => commandSelection(selectedSteps.find((item) => item['id'] === id)!['command'] ?? null,
    `workflow step ${id}`).canonical);
  const executionOrder = selections.flatMap((selection) => Array.from({ length: input.attempts }, (_, index) => selected.map((id) => ({ model: selection.exact, attempt: index + 1, step_id: id })))).flat();
  const core = {
    schema_version: WORKFLOW_PLAN_SCHEMA_VERSION, source: { repository_id: input.repositoryId, source_ref: sourceRef, source_commit: sourceCommit,
      workflow_path: relative, raw_sha256: parsed.raw_sha256, semantics_sha256: parsed.semantics_sha256 },
    snapshot: { source_tree: sourceTree, identity: canonicalHash({ repository_id: input.repositoryId, source_commit: sourceCommit, source_tree: sourceTree }) },
    workflow_schema_version: parsed.schema_version, compiler_version: WORKFLOW_COMPILER_VERSION, normalized_workflow: parsed.semantics,
    variables, variables_hash: canonicalHash(variables), selected_step_ids: selected, execution_order: executionOrder, attempts: input.attempts,
    models: selections.map((item) => item.exact), model_dispatch_step_ids: modelDispatchStepIds,
    model_selectors: Object.fromEntries(selections.map((item) => [item.exact, item.selector])), workflow_model_policy: modelPolicy,
    policy: policyBinding.policy, policy_raw_sha256: policyBinding.raw_sha256, policy_semantics_sha256: policyBinding.semantics_sha256, compiled_workflows: compiled,
  };
  const plan = { ...core, plan_id: canonicalHash(core) };
  return Object.freeze(WorkflowExecutionPlanSchema.parse(plan));
}

export function verifyWorkflowPlanBindings(plan: WorkflowExecutionPlan, workflowRaw: Uint8Array, policyRaw: Uint8Array): void {
  const { plan_id: claimed, ...core } = WorkflowExecutionPlanSchema.parse(plan);
  if (claimed !== canonicalHash(core)) throw new Error('workflow execution plan hash is invalid');
  const workflow = parseWorkflowBytes(workflowRaw); const policy = parseWorkflowPolicyBytes(policyRaw);
  if (workflow.raw_sha256 !== plan.source.raw_sha256) throw new Error('workflow raw-byte drift detected');
  if (workflow.semantics_sha256 !== plan.source.semantics_sha256) throw new Error('workflow semantic drift detected');
  if (policy.raw_sha256 !== plan.policy_raw_sha256 || policy.semantics_sha256 !== plan.policy_semantics_sha256) throw new Error('workflow policy drift detected');
}
