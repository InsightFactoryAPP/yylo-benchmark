import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';

export const CONFIG_SCHEMA_VERSION = 'juno_benchmark_config.v1' as const;
export const CONFIG_FILENAME = 'juno-benchmark.config.json';

export const BenchmarkConfigSchema = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  repository_id: z.string().trim().min(1).default('root'),
  kanban: z.object({
    executable: z.string().trim().min(1).optional(),
    arguments: z.array(z.string()).default([]),
  }).strict().default({ arguments: [] }),
  model_aliases: z.record(
    z.string().regex(/^:[A-Za-z0-9._-]+$/u, 'expected a colon-prefixed model alias'),
    z.string().regex(/^[^:/\s]+\/[^:/\s]+$/u, 'expected an exact provider/model identity'),
  ).default({}),
  grader_profiles: z.record(z.string().trim().min(1), z.object({
    executable: z.string().trim().min(1),
    arguments: z.array(z.string()).default([]),
    grader_id: z.string().trim().min(1),
    grader_version: z.string().trim().min(1),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  }).strict()).default({}),
}).strict();

export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

export interface LoadedConfig {
  readonly config: BenchmarkConfig;
  readonly configPath: string | null;
  readonly projectRoot: string;
}

export interface ResolvedKanbanCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

async function gitValues(root: string, key: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'config', '--get-all', key], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1) return [];
    throw new Error(`cannot inspect registered metadata controller: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function registeredKanbanWrapper(projectRoot: string): Promise<ResolvedKanbanCommand | null> {
  const [paths, branches] = await Promise.all([
    gitValues(projectRoot, 'juno.controller.path'), gitValues(projectRoot, 'juno.controller.branch'),
  ]);
  if (paths.length === 0 && branches.length === 0) return null;
  if (paths.length !== 1 || branches.length !== 1) {
    throw new Error('registered metadata controller is ambiguous or incomplete; run `yy doctor workspace`');
  }
  const declared = path.resolve(projectRoot, paths[0]!);
  let controller: string;
  try { controller = await realpath(declared); }
  catch { throw new Error(`registered metadata controller does not exist: ${declared}`); }
  const policy = path.join(controller, '.juno_task', 'config', 'metadata-controller.json');
  const wrapper = path.join(controller, '.juno_task', 'scripts', 'kanban.sh');
  if (!(await exists(policy)) || !(await exists(wrapper))) {
    throw new Error(`registered metadata controller is not a readable metadata controller: ${controller}`);
  }
  const { stdout } = await execFileAsync('git', ['-C', controller, 'symbolic-ref', '--quiet', 'HEAD'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const expected = branches[0]!.startsWith('refs/heads/') ? branches[0]! : `refs/heads/${branches[0]!}`;
  if (stdout.trim() !== expected) {
    throw new Error(`registered metadata controller branch mismatch: expected ${expected}, found ${stdout.trim() || 'detached'}`);
  }
  return { executable: wrapper, arguments: [], cwd: controller };
}

async function findUp(start: string, name: string): Promise<string | null> {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, name);
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadConfig(options: { cwd?: string; configPath?: string } = {}): Promise<LoadedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitPath = options.configPath === undefined ? undefined : path.resolve(cwd, options.configPath);
  const configPath = explicitPath ?? await findUp(cwd, CONFIG_FILENAME);
  if (explicitPath !== undefined && !(await exists(explicitPath))) {
    throw new Error(`benchmark config does not exist: ${explicitPath}`);
  }
  if (configPath === null) {
    const wrapper = await findUp(cwd, path.join('.juno_task', 'scripts', 'kanban.sh'));
    const projectRoot = wrapper === null
      ? cwd
      : path.dirname(path.dirname(path.dirname(wrapper)));
    return {
      config: BenchmarkConfigSchema.parse({ schema_version: CONFIG_SCHEMA_VERSION }),
      configPath: null,
      projectRoot,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`cannot read benchmark config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    config: BenchmarkConfigSchema.parse(parsed),
    configPath,
    projectRoot: path.dirname(configPath),
  };
}

export async function resolveKanbanCommand(loaded: LoadedConfig): Promise<ResolvedKanbanCommand> {
  const environment = process.env['JUNO_BENCHMARK_KANBAN_COMMAND']?.trim();
  if (environment !== undefined && environment !== '') {
    return { executable: environment, arguments: [], cwd: loaded.projectRoot };
  }
  if (loaded.config.kanban.executable !== undefined) {
    return { executable: loaded.config.kanban.executable, arguments: loaded.config.kanban.arguments, cwd: loaded.projectRoot };
  }
  const registered = await registeredKanbanWrapper(loaded.projectRoot);
  if (registered !== null) return registered;
  const localWrapper = path.join(loaded.projectRoot, '.juno_task', 'scripts', 'kanban.sh');
  if (await exists(localWrapper)) return { executable: localWrapper, arguments: [], cwd: loaded.projectRoot };
  return { executable: 'juno-kanban', arguments: [], cwd: loaded.projectRoot };
}
