import { appendFile, chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalHash, canonicalJson, sha256Hex } from '../contracts/canonical.js';
import type { KanbanTask } from '../kanban/client.js';

export const SHADOW_SCHEMA_VERSION = 'juno_benchmark_shadow_kanban.v1' as const;

const ROUTING_NAMES = new Set([
  'JUNO_TASK_ROOT', 'JUNO_CONTROLLER_ROOT', 'JUNO_CANONICAL_CONTROLLER',
  'JUNO_KANBAN_ROOT', 'JUNO_KANBAN_CONFIG', 'JUNO_KANBAN_COMMAND',
  'JUNO_CONTROLLER_REGISTRY', 'JUNO_WORKSPACE_ROLE', 'JUNO_WORKSPACE_ENFORCEMENT',
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);
const SENSITIVE_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION|COOKIE)(?:$|_)/iu;
const PROVIDER_NAME = /^(?:AWS_|AZURE_|GOOGLE_|GCP_|OPENAI_|ANTHROPIC_|GITHUB_|GITLAB_|NPM_|PYPI_|DOCKER_)/u;
const BENCHMARK_CONTROL_NAME = /^YYLO_BENCHMARK_/u;

export interface ShadowTaskContext {
  readonly selectedTask: KanbanTask;
  readonly relatedTasks?: readonly KanbanTask[];
}

export interface ShadowKanbanManifest {
  readonly schema_version: typeof SHADOW_SCHEMA_VERSION;
  readonly selected_task_id: string;
  readonly declared_task_ids: readonly string[];
  readonly task_hashes: Readonly<Record<string, `sha256:${string}`>>;
  readonly content_identity: `sha256:${string}`;
  readonly root: '.juno_task';
  readonly writable: true;
  readonly retained: true;
  readonly canonical_routing: 'absent';
}

export interface CreateShadowKanbanOptions extends ShadowTaskContext {
  readonly repository: string;
}

export interface ShadowDoctorOptions {
  readonly repository: string;
  readonly manifest: ShadowKanbanManifest;
  readonly canonicalControllerPaths?: readonly string[];
}

function validateTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(taskId)) throw new Error(`invalid shadow task ID: ${taskId}`);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(name: string, values: readonly string[]): string {
  return values.length === 0
    ? `${name}: []`
    : `${name}:\n${values.map((value) => `- ${yamlString(value)}`).join('\n')}`;
}

function taskDocument(task: KanbanTask, declaredIds: ReadonlySet<string>): string {
  const related = task.related_tasks.filter((id) => declaredIds.has(id));
  const blocked = task.blocked_by.filter((id) => declaredIds.has(id));
  const response = typeof task['agent_response'] === 'string' ? task['agent_response'] : '';
  const commit = task.commit_hash === null || task.commit_hash === undefined ? '' : ` ${yamlString(task.commit_hash)}`;
  return `---\nid: ${yamlString(task.id)}\nstatus: ${yamlString(task.status)}\ncreated_date: ${yamlString(typeof task['created_date'] === 'string' ? task['created_date'] : task.last_modified)}\nlast_modified: ${yamlString(task.last_modified)}\ncommit_hash:${commit}\n${yamlList('feature_tags', task.feature_tags)}\n${yamlList('related_tasks', related)}\n${yamlList('blocked_by', blocked)}\nschema_version: ${typeof task['schema_version'] === 'number' ? task['schema_version'] : 1}\nfields: ${canonicalJson(task.fields)}\n---\n\n<!-- juno:body:start -->\n${task.body}\n<!-- juno:body:end -->\n\n<!-- juno:response:start -->\n${response}\n<!-- juno:response:end -->\n`;
}

const LOCAL_CONFIG = {
  version: '1.0',
  status_workflow: {
    enabled: true,
    values: ['backlog', 'todo', 'in_progress', 'done', 'archive'],
    default: 'backlog',
    transitions: {},
    enforce_transitions: false,
    allow_any_to_archive: true,
  },
  feature_tags: { enabled: true, allowed_tags: null, max_tags_per_task: 20, validation_pattern: '^[a-zA-Z0-9_-]{1,50}$', case_sensitive: false, auto_create: true },
  storage: { base_path: '.juno_task/tasks', file_pattern: '*.ndjson', default_file: 'backlog.ndjson', ledger_segment_bytes: 5_242_880, max_file_size: 10_485_760, enable_auto_rotation: false },
  search: { default_limit: 5, use_ripgrep: false, ripgrep_path: null, case_sensitive: false },
  output: { default_format: 'ndjson', pretty_print: false, color: false, timestamp_format: 'iso8601', redaction_patterns: [] },
  project_root: { auto_detect: false, root_markers: ['.git'], max_depth: 1, non_root_behavior: 'error', enable_prevention: true },
  help_text: {},
  error_messages: {},
};

const WRAPPER = `#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
global=(-c "$ROOT/.juno_task/tasks/config.json")
command=()
# Keep public-CLI output flags usable in the conventional command-last position,
# but never permit a candidate-selected config or project route.
while (($#)); do
  case "$1" in
    -c|--config|--config=*|--project|--project=*) echo "shadow Kanban: alternate routing is forbidden" >&2; exit 64;;
    -f|--format) (($# >= 2)) || { echo "shadow Kanban: missing value for $1" >&2; exit 64; }; global+=("$1" "$2"); shift 2;;
    -p|--pretty|--raw|-v|--verbose|--version) global+=("$1"); shift;;
    *) command+=("$1"); shift;;
  esac
done
exec env \
  -u JUNO_TASK_ROOT -u JUNO_CONTROLLER_ROOT -u JUNO_CANONICAL_CONTROLLER \
  -u JUNO_KANBAN_ROOT -u JUNO_KANBAN_CONFIG -u JUNO_KANBAN_COMMAND \
  -u GIT_DIR -u GIT_COMMON_DIR -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
  "\${YYLO_BENCHMARK_SHADOW_KANBAN_EXECUTABLE:-yylo-ledger}" "\${global[@]}" "\${command[@]}"
`;

function taskHash(task: KanbanTask): `sha256:${string}` {
  return canonicalHash({
    id: task.id, status: task.status, body: task.body, last_modified: task.last_modified,
    commit_hash: task.commit_hash ?? null, feature_tags: task.feature_tags,
    related_tasks: task.related_tasks, blocked_by: task.blocked_by, fields: task.fields,
  });
}

async function ensureAbsent(target: string): Promise<void> {
  try { await lstat(target); throw new Error(`shadow Kanban path already exists: ${target}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Seed only owner-declared context. The board remains in-place as writable attempt evidence. */
export async function createShadowKanban(options: CreateShadowKanbanOptions): Promise<ShadowKanbanManifest> {
  const repository = path.resolve(options.repository);
  const gitDirectory = path.join(repository, '.git');
  if (!(await lstat(gitDirectory)).isDirectory()) throw new Error('shadow Kanban requires a private candidate Git repository');
  const shadow = path.join(repository, '.juno_task');
  await ensureAbsent(shadow);
  const tasks = [options.selectedTask, ...(options.relatedTasks ?? [])];
  const ids = new Set<string>();
  for (const task of tasks) {
    validateTaskId(task.id);
    if (ids.has(task.id)) throw new Error(`duplicate declared shadow task: ${task.id}`);
    ids.add(task.id);
  }
  if (!ids.has(options.selectedTask.id)) throw new Error('selected shadow task is missing');
  const declared = [...ids].sort();
  const hashes: Record<string, `sha256:${string}`> = {};
  await mkdir(path.join(shadow, 'tasks'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(shadow, 'ledger'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(shadow, 'cache'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(shadow, 'home'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(shadow, 'scripts'), { recursive: true, mode: 0o700 });
  for (const task of tasks) {
    const directory = path.join(shadow, 'tasks', task.id.slice(0, 2).toLowerCase());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, `${task.id}.md`), taskDocument(task, ids), { mode: 0o600, flag: 'wx' });
    hashes[task.id] = taskHash(task);
  }
  await writeFile(path.join(shadow, 'tasks', 'config.json'), `${JSON.stringify(LOCAL_CONFIG, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const gitExclude = path.join(repository, '.git', 'info', 'exclude');
  await mkdir(path.dirname(gitExclude), { recursive: true });
  await appendFile(gitExclude, '\n# Candidate-local retained benchmark evidence\n.juno_task/\n', { encoding: 'utf8', mode: 0o600 });
  const wrapper = path.join(shadow, 'scripts', 'kanban.sh');
  await writeFile(wrapper, WRAPPER, { mode: 0o700, flag: 'wx' });
  await chmod(wrapper, 0o700);
  const identityInput = { schema_version: SHADOW_SCHEMA_VERSION, selected_task_id: options.selectedTask.id, declared_task_ids: declared, task_hashes: hashes } as const;
  return {
    ...identityInput,
    content_identity: canonicalHash(identityInput),
    root: '.juno_task', writable: true, retained: true, canonical_routing: 'absent',
  };
}

/** Remove controller routing and credentials before any candidate process is spawned. */
export function sanitizeCandidateEnvironment(input: NodeJS.ProcessEnv, repository: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || ROUTING_NAMES.has(name) || BENCHMARK_CONTROL_NAME.test(name) || SENSITIVE_NAME.test(name) || PROVIDER_NAME.test(name) || name === 'SSH_AUTH_SOCK' || name === 'NETRC') continue;
    result[name] = value;
  }
  const home = path.join(path.resolve(repository), '.juno_task', 'home');
  result['HOME'] = home;
  result['XDG_CONFIG_HOME'] = path.join(home, '.config');
  result['XDG_CACHE_HOME'] = path.join(home, '.cache');
  result['GIT_CONFIG_NOSYSTEM'] = '1';
  result['GIT_CONFIG_GLOBAL'] = '/dev/null';
  return result;
}

async function taskFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const prefix of await readdir(root, { withFileTypes: true })) {
    if (prefix.isFile() && prefix.name === 'config.json') continue;
    if (!prefix.isDirectory() || !/^[a-z0-9_-]{1,2}$/u.test(prefix.name)) throw new Error(`shadow doctor: unexpected task storage entry ${prefix.name}`);
    for (const entry of await readdir(path.join(root, prefix.name), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name.slice(0, 2).toLowerCase() === prefix.name) found.push(entry.name.slice(0, -3));
      else throw new Error(`shadow doctor: unexpected task storage entry ${prefix.name}/${entry.name}`);
    }
  }
  return found.sort();
}

export async function doctorShadowKanban(options: ShadowDoctorOptions): Promise<{ readonly ok: true; readonly content_identity: `sha256:${string}` }> {
  const shadow = path.join(path.resolve(options.repository), '.juno_task');
  if (!(await lstat(shadow)).isDirectory()) throw new Error('shadow doctor: .juno_task is not a private directory');
  const actualIds = await taskFiles(path.join(shadow, 'tasks'));
  if (JSON.stringify(actualIds) !== JSON.stringify([...options.manifest.declared_task_ids].sort())) {
    throw new Error(`shadow doctor: undeclared or missing task context (${actualIds.join(', ')})`);
  }
  const config = await readFile(path.join(shadow, 'tasks', 'config.json'), 'utf8');
  const parsed = JSON.parse(config) as { storage?: { base_path?: unknown }; project_root?: { auto_detect?: unknown } };
  if (parsed.storage?.base_path !== '.juno_task/tasks' || parsed.project_root?.auto_detect !== false) throw new Error('shadow doctor: storage is not fixed to the local board');
  const wrapper = await readFile(path.join(shadow, 'scripts', 'kanban.sh'), 'utf8');
  const allText = `${config}\n${wrapper}`;
  for (const controller of options.canonicalControllerPaths ?? []) {
    if (controller !== '' && allText.includes(controller)) throw new Error('shadow doctor: canonical controller routing leaked into board');
  }
  if (!wrapper.includes('global=(-c "$ROOT/.juno_task/tasks/config.json")') || !wrapper.includes('-u JUNO_TASK_ROOT')) throw new Error('shadow doctor: local routing guard is missing');
  let exclude: string;
  try { exclude = await readFile(path.join(options.repository, '.git', 'info', 'exclude'), 'utf8'); }
  catch { throw new Error('shadow doctor: candidate Git exclude is missing'); }
  if (!exclude.split(/\r?\n/u).includes('.juno_task/')) throw new Error('shadow doctor: retained board is not excluded from candidate patches');
  const identity = canonicalHash({ schema_version: SHADOW_SCHEMA_VERSION, selected_task_id: options.manifest.selected_task_id, declared_task_ids: options.manifest.declared_task_ids, task_hashes: options.manifest.task_hashes });
  if (identity !== options.manifest.content_identity) throw new Error('shadow doctor: content identity mismatch');
  for (const id of actualIds) {
    const bytes = await readFile(path.join(shadow, 'tasks', id.slice(0, 2).toLowerCase(), `${id}.md`));
    if (bytes.includes(Buffer.from('\0'))) throw new Error(`shadow doctor: invalid task bytes for ${id}`);
  }
  return { ok: true, content_identity: identity };
}

export function shadowEvidenceDigest(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}
