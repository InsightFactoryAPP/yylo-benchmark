import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'dotenv';
import { z } from 'zod';
import { canonicalJson } from '../contracts/canonical.js';
import { resolveKanbanCommand, type LoadedConfig } from '../config/index.js';

export const ENVIRONMENT_PREPARATION_SCHEMA_VERSION = 'juno_benchmark_environment_preparation.v1' as const;
export const ENVIRONMENT_PREPARATION_FILENAME = path.join('.juno_task', 'artifacts', 'yylo-benchmark', 'environment-preparation.json');

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const preparationSchema = z.object({
  schema_version: z.literal(ENVIRONMENT_PREPARATION_SCHEMA_VERSION),
  env: z.object({ canonical: z.literal('.env.yylo'), legacy: z.literal('.env.juno'), migrated: z.boolean(), mode: z.literal('0600') }).strict(),
  repository: z.object({ git_worktree: z.literal(true), kanban_cwd: z.string().min(1), kanban_executable: z.string().min(1) }).strict(),
  python: z.object({
    bootstrap: z.string().min(1), venv: z.string().min(1), interpreter: z.string().min(1), version: z.string().min(1),
    requirements: z.array(z.object({ path: z.string().min(1), sha256 }).strict()).min(1),
    packages: z.array(z.string()), imports: z.array(z.string()),
  }).strict().nullable(),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export type EnvironmentPreparationReceipt = z.infer<typeof preparationSchema>;
const execFileAsync = promisify(execFile);

function installEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD)/u.test(key)));
}

function assertInsideProject(projectRoot: string, resolved: string, label: string): void {
  const relative = path.relative(projectRoot, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return;
  throw new Error(`${label} resolves outside the benchmark project root`);
}

async function readable(file: string): Promise<boolean> {
  try { await access(file, constants.R_OK); return true; } catch { return false; }
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function preparationPath(projectRoot: string): string {
  return path.join(projectRoot, ENVIRONMENT_PREPARATION_FILENAME);
}

async function writeAtomicJson(destination: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.tmp`);
  await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode, flag: 'wx' });
  await rename(temporary, destination);
  await chmod(destination, mode);
}

async function reconcileYyloConfig(projectRoot: string): Promise<void> {
  const destination = path.join(projectRoot, '.juno_task', 'config.json');
  if (!(await readable(destination))) return;
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(destination, 'utf8')) as unknown; }
  catch { throw new Error('cannot migrate canonical environment: .juno_task/config.json is malformed'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cannot migrate canonical environment: .juno_task/config.json must be an object');
  const config = parsed as Record<string, unknown>;
  if (config['envFilePath'] !== undefined && config['envFilePath'] !== '.env.juno' && config['envFilePath'] !== '.env.yylo') return;
  if (config['envFilePath'] === '.env.yylo' && config['envFileCopied'] === true) return;
  await writeAtomicJson(destination, { ...config, envFilePath: '.env.yylo', envFileCopied: true });
}

async function ensureCanonicalEnv(loaded: LoadedConfig): Promise<{ migrated: boolean }> {
  const canonical = path.join(loaded.projectRoot, loaded.config.environment.env_file);
  const legacy = path.join(loaded.projectRoot, loaded.config.environment.legacy_env_file);
  const hasCanonical = await readable(canonical); const hasLegacy = await readable(legacy);
  let migrated = false;
  if (!hasCanonical && hasLegacy) {
    await copyFile(legacy, canonical, constants.COPYFILE_EXCL);
    migrated = true;
  } else if (!hasCanonical) {
    await writeFile(canonical, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } else if (hasLegacy) {
    const canonicalValues = parse(await readFile(canonical)); const legacyValues = parse(await readFile(legacy));
    const conflicts = Object.keys(canonicalValues).filter((key) => legacyValues[key] !== undefined && legacyValues[key] !== canonicalValues[key]);
    if (conflicts.length > 0) throw new Error(`canonical .env.yylo and legacy .env.juno contain ${conflicts.length} conflicting key(s); reconcile them before benchmark setup`);
  }
  const envMetadata = await lstat(canonical);
  if (!envMetadata.isFile() || envMetadata.isSymbolicLink()) throw new Error('canonical .env.yylo must be a non-symlinked regular file');
  await chmod(canonical, 0o600);
  await reconcileYyloConfig(loaded.projectRoot);
  return { migrated };
}

async function repositoryIdentity(loaded: LoadedConfig): Promise<EnvironmentPreparationReceipt['repository']> {
  try {
    await execFileAsync('git', ['-C', loaded.projectRoot, 'status', '--porcelain=2', '--untracked-files=no'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...installEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch {
    throw new Error('consumer repository or one of its registered submodule worktrees is unreadable; repair it before benchmark setup');
  }
  const kanban = await resolveKanbanCommand(loaded);
  return { git_worktree: true, kanban_cwd: kanban.cwd, kanban_executable: kanban.executable };
}

export async function loadBenchmarkEnvironment(loaded: LoadedConfig): Promise<void> {
  const canonical = path.join(loaded.projectRoot, loaded.config.environment.env_file);
  if (!(await readable(canonical))) throw new Error('canonical .env.yylo is missing; run `yylo benchmark prepare`');
  let values: Record<string, string>;
  try { values = parse(await readFile(canonical)); }
  catch { throw new Error('canonical .env.yylo cannot be parsed'); }
  for (const [key, value] of Object.entries(values)) if (process.env[key] === undefined) process.env[key] = value;
  const python = loaded.config.environment.python;
  if (python !== undefined) {
    const bin = path.join(loaded.projectRoot, python.venv, process.platform === 'win32' ? 'Scripts' : 'bin');
    const entries = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
    process.env['PATH'] = [bin, ...entries.filter((entry) => path.resolve(entry) !== path.resolve(bin))].join(path.delimiter);
    process.env['VIRTUAL_ENV'] = path.join(loaded.projectRoot, python.venv);
  }
}

async function pythonIdentity(loaded: LoadedConfig): Promise<EnvironmentPreparationReceipt['python']> {
  const config = loaded.config.environment.python;
  if (config === undefined) return null;
  const canonicalRoot = await realpath(loaded.projectRoot);
  const venv = path.join(loaded.projectRoot, config.venv);
  let canonicalVenv: string;
  try { canonicalVenv = await realpath(venv); } catch { throw new Error(`prepared Python environment is missing from ${config.venv}`); }
  assertInsideProject(canonicalRoot, canonicalVenv, 'prepared Python environment');
  const executable = path.join(loaded.projectRoot, config.venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try { await realpath(executable); } catch { throw new Error(`prepared Python interpreter is missing from ${config.venv}`); }
  const interpreter = path.join(canonicalVenv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let version: string;
  try { ({ stdout: version } = await execFileAsync(interpreter, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, env: installEnvironment() })); }
  catch { throw new Error(`cannot execute prepared Python interpreter from ${config.venv}`); }
  const requirements = [];
  for (const relative of config.requirements) {
    const absolute = path.join(loaded.projectRoot, relative);
    let bytes: Buffer;
    try {
      const resolved = await realpath(absolute); assertInsideProject(canonicalRoot, resolved, `benchmark requirement file ${relative}`);
      if (!(await lstat(absolute)).isFile()) throw new Error('not a file');
      bytes = await readFile(resolved);
    } catch (error) {
      if (error instanceof Error && error.message.includes('resolves outside')) throw error;
      throw new Error(`benchmark requirement file is missing or invalid: ${relative}`);
    }
    requirements.push({ path: relative, sha256: digest(bytes) });
  }
  if (config.imports.length > 0) {
    const probe = `import importlib\n${config.imports.map((name) => `importlib.import_module(${JSON.stringify(name)})`).join('\n')}`;
    try { await execFileAsync(interpreter, ['-c', probe], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024, env: installEnvironment() }); }
    catch { throw new Error('prepared Python environment failed one or more configured import probes'); }
  }
  return { bootstrap: config.bootstrap, venv: config.venv, interpreter, version: version.trim(), requirements, packages: config.packages, imports: config.imports };
}

export async function verifyBenchmarkEnvironment(loaded: LoadedConfig): Promise<EnvironmentPreparationReceipt> {
  let receipt: EnvironmentPreparationReceipt;
  try { receipt = preparationSchema.parse(JSON.parse(await readFile(preparationPath(loaded.projectRoot), 'utf8'))); }
  catch { throw new Error('benchmark environment preparation receipt is missing or malformed; run `yylo benchmark prepare`'); }
  if (!(await readable(path.join(loaded.projectRoot, '.env.yylo')))) throw new Error('canonical .env.yylo is missing after benchmark preparation');
  const metadata = await lstat(path.join(loaded.projectRoot, '.env.yylo'));
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('canonical .env.yylo must remain a non-symlinked regular file');
  if ((metadata.mode & 0o777) !== 0o600) throw new Error('canonical .env.yylo must have mode 0600');
  const currentRepository = await repositoryIdentity(loaded);
  if (canonicalJson(currentRepository) !== canonicalJson(receipt.repository)) throw new Error('benchmark consumer repository/controller identity drifted; run `yylo benchmark prepare`');
  const currentPython = await pythonIdentity(loaded);
  if (canonicalJson(currentPython) !== canonicalJson(receipt.python)) throw new Error('benchmark Python environment or requirement identity drifted; run `yylo benchmark prepare`');
  return receipt;
}

async function installPython(loaded: LoadedConfig): Promise<void> {
  const config = loaded.config.environment.python;
  if (config === undefined) return;
  const venv = path.join(loaded.projectRoot, config.venv);
  const executable = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!(await readable(executable))) {
    const bootstrap = config.bootstrap.includes('/') || config.bootstrap.includes('\\') ? path.join(loaded.projectRoot, config.bootstrap) : config.bootstrap;
    try { await execFileAsync(bootstrap, ['-m', 'venv', venv], { cwd: loaded.projectRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, env: installEnvironment() }); }
    catch { throw new Error(`failed to create benchmark Python environment at ${config.venv}`); }
  }
  for (const requirement of config.requirements) {
    try { await execFileAsync(executable, ['-m', 'pip', 'install', '-r', requirement], { cwd: loaded.projectRoot, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024, env: installEnvironment() }); }
    catch { throw new Error(`failed to install benchmark requirements from ${requirement}`); }
  }
  if (config.packages.length > 0) {
    try { await execFileAsync(executable, ['-m', 'pip', 'install', ...config.packages], { cwd: loaded.projectRoot, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024, env: installEnvironment() }); }
    catch { throw new Error('failed to install configured benchmark Python packages'); }
  }
  try { await execFileAsync(executable, ['-m', 'pip', 'check'], { cwd: loaded.projectRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, env: installEnvironment() }); }
  catch { throw new Error('prepared benchmark Python environment contains broken package requirements'); }
}

export async function prepareBenchmarkEnvironment(loaded: LoadedConfig): Promise<EnvironmentPreparationReceipt> {
  const repository = await repositoryIdentity(loaded);
  const env = await ensureCanonicalEnv(loaded);
  await installPython(loaded);
  await loadBenchmarkEnvironment(loaded);
  const receipt: EnvironmentPreparationReceipt = {
    schema_version: ENVIRONMENT_PREPARATION_SCHEMA_VERSION,
    env: { canonical: '.env.yylo', legacy: '.env.juno', migrated: env.migrated, mode: '0600' },
    repository,
    python: await pythonIdentity(loaded),
    created_at: new Date().toISOString(),
  };
  await writeAtomicJson(preparationPath(loaded.projectRoot), receipt);
  return receipt;
}
