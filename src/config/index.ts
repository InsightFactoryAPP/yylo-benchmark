import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
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

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
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

export async function resolveKanbanCommand(loaded: LoadedConfig): Promise<{ executable: string; arguments: readonly string[] }> {
  const environment = process.env['JUNO_BENCHMARK_KANBAN_COMMAND']?.trim();
  if (environment !== undefined && environment !== '') return { executable: environment, arguments: [] };
  if (loaded.config.kanban.executable !== undefined) {
    return { executable: loaded.config.kanban.executable, arguments: loaded.config.kanban.arguments };
  }
  const localWrapper = path.join(loaded.projectRoot, '.juno_task', 'scripts', 'kanban.sh');
  if (await exists(localWrapper)) return { executable: localWrapper, arguments: [] };
  return { executable: 'juno-kanban', arguments: [] };
}
