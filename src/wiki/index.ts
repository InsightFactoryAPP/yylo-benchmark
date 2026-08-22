import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BENCHMARK_WIKI_NAMESPACE = '.juno_task/wiki/yylo-benchmark' as const;
export const BENCHMARK_PROJECT_WIKI_PREFIX = 'yylo-benchmark/project/' as const;
// Durable managed-page protocol version; independent from product marketing identity.
export const BENCHMARK_WIKI_TEMPLATE_VERSION = 'juno-benchmark-wiki.v1' as const;

export const BENCHMARK_WIKI_PAGES = [
  'overview.md',
  'case_authoring.md',
  'experiment_lifecycle.md',
  'telemetry_and_retention.md',
  'model_comparison.md',
] as const;

export type BenchmarkWikiPage = typeof BENCHMARK_WIKI_PAGES[number];

interface ManagedPageRecord {
  readonly source_sha256: string;
  readonly installed_sha256: string;
}

interface ManagedWikiManifest {
  readonly schema_version: 1;
  readonly package_name: '@yylo/benchmark';
  readonly template_version: typeof BENCHMARK_WIKI_TEMPLATE_VERSION;
  readonly pages: Record<string, ManagedPageRecord>;
}

export interface BenchmarkWikiInstallResult {
  readonly installed: string[];
  readonly updated: string[];
  readonly unchanged: string[];
  readonly conflicts: Array<{ readonly destination: string; readonly candidate: string }>;
  readonly backups: Array<{ readonly destination: string; readonly backup: string }>;
}

export interface InstallBenchmarkWikisOptions {
  readonly projectRoot: string;
  /** Test/package override. The directory must contain only the five managed templates. */
  readonly templatesDirectory?: string;
}

export interface SelectedProjectWiki {
  /** Normalized path relative to .juno_task/wiki. */
  readonly path: string;
  readonly sha256: `sha256:${string}`;
}

export interface HashProjectWikisOptions {
  readonly projectRoot: string;
  /** Defaults to the project-installed YYLO wiki_lint.sh public script. */
  readonly linter?: string;
}

const MANIFEST_NAME = '.managed-pages.json';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function entry(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function relativeDestination(page: BenchmarkWikiPage): string {
  return `${BENCHMARK_WIKI_NAMESPACE}/${page}`;
}

function emptyManifest(): ManagedWikiManifest {
  return {
    schema_version: 1,
    package_name: '@yylo/benchmark',
    template_version: BENCHMARK_WIKI_TEMPLATE_VERSION,
    pages: {},
  };
}

function safeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '_');
}

/** Reject symlinked ancestors before any package-managed write. */
async function assertSafeWritePath(projectRoot: string, target: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`benchmark wiki write escapes project root: ${target}`);
  }
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const currentEntry = await entry(current);
    if (currentEntry?.isSymbolicLink()) {
      throw new Error(`benchmark wiki path contains a symbolic link: ${current}`);
    }
  }
}

async function writeAtomic(projectRoot: string, destination: string, bytes: Uint8Array): Promise<void> {
  await assertSafeWritePath(projectRoot, destination);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, destination);
}

function defaultTemplatesDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  // The first path is source/Vitest layout; the second is packaged dist layout.
  const candidates = [
    path.join(moduleDirectory, '..', 'templates', 'wiki'),
    path.join(moduleDirectory, 'templates', 'wiki'),
    path.join(moduleDirectory, '..', 'src', 'templates', 'wiki'),
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (selected === undefined) throw new Error('benchmark wiki templates are missing from this package');
  return selected;
}

async function loadManifest(manifestPath: string): Promise<ManagedWikiManifest> {
  const manifestEntry = await entry(manifestPath);
  if (manifestEntry === null) return emptyManifest();
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) {
    throw new Error(`benchmark wiki manifest is not a regular file: ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`cannot read benchmark wiki manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = parsed as Partial<ManagedWikiManifest>;
  if (
    candidate.schema_version !== 1 ||
    !['@yylo/benchmark', '@juno-ai/juno-benchmark'].includes(candidate.package_name ?? '') ||
    candidate.template_version !== BENCHMARK_WIKI_TEMPLATE_VERSION ||
    candidate.pages === null || typeof candidate.pages !== 'object'
  ) {
    throw new Error(`unsupported benchmark wiki manifest: ${manifestPath}`);
  }
  return candidate as ManagedWikiManifest;
}

async function preservedPath(
  projectRoot: string,
  root: string,
  relative: string,
  suffix: 'backup' | 'candidate',
  bytes: Uint8Array,
): Promise<string> {
  const initial = path.join(root, `${relative}.${suffix}`);
  let selected = initial;
  const existing = await entry(selected);
  if (existing !== null) {
    if (existing.isFile() && digest(await readFile(selected)) === digest(bytes)) {
      return path.relative(projectRoot, selected).split(path.sep).join('/');
    }
    selected = path.join(root, `${relative}.${digest(bytes).slice(0, 16)}.${suffix}`);
    const hashedExisting = await entry(selected);
    if (hashedExisting !== null) {
      if (hashedExisting.isFile() && digest(await readFile(selected)) === digest(bytes)) {
        return path.relative(projectRoot, selected).split(path.sep).join('/');
      }
      throw new Error(`benchmark wiki preservation path already contains different content: ${selected}`);
    }
  }
  await writeAtomic(projectRoot, selected, bytes);
  return path.relative(projectRoot, selected).split(path.sep).join('/');
}

/**
 * Install or update the package-owned pages. Existing untracked/customized bytes are
 * retained and the package candidate is written separately. The project-owned
 * subtree is never read or written by this operation.
 */
export async function installBenchmarkWikis(options: InstallBenchmarkWikisOptions): Promise<BenchmarkWikiInstallResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const templateRoot = path.resolve(options.templatesDirectory ?? defaultTemplatesDirectory());
  const namespaceRoot = path.join(projectRoot, BENCHMARK_WIKI_NAMESPACE);
  const manifestPath = path.join(namespaceRoot, MANIFEST_NAME);
  await assertSafeWritePath(projectRoot, namespaceRoot);
  const manifest = await loadManifest(manifestPath);
  const nextPages: Record<string, ManagedPageRecord> = { ...manifest.pages };
  const result: BenchmarkWikiInstallResult = {
    installed: [], updated: [], unchanged: [], conflicts: [], backups: [],
  };
  const conflictRoot = path.join(
    projectRoot, '.juno_task', 'managed-conflicts', 'yylo-benchmark',
    safeLabel(BENCHMARK_WIKI_TEMPLATE_VERSION),
  );
  const backupRoot = path.join(
    projectRoot, '.juno_task', 'managed-backups', 'yylo-benchmark',
    safeLabel(BENCHMARK_WIKI_TEMPLATE_VERSION),
  );

  for (const page of BENCHMARK_WIKI_PAGES) {
    const source = path.join(templateRoot, page);
    const sourceEntry = await entry(source);
    if (sourceEntry === null || !sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
      throw new Error(`benchmark wiki template is missing or unsafe: ${source}`);
    }
    const sourceBytes = await readFile(source);
    const sourceHash = digest(sourceBytes);
    const destinationRelative = relativeDestination(page);
    const destination = path.join(projectRoot, destinationRelative);
    const destinationEntry = await entry(destination);
    if (destinationEntry !== null && (!destinationEntry.isFile() || destinationEntry.isSymbolicLink())) {
      throw new Error(`benchmark wiki destination is not a regular file: ${destination}`);
    }
    const previous = manifest.pages[page];

    if (destinationEntry === null) {
      await writeAtomic(projectRoot, destination, sourceBytes);
      nextPages[page] = { source_sha256: sourceHash, installed_sha256: sourceHash };
      result.installed.push(destinationRelative);
      continue;
    }

    const currentBytes = await readFile(destination);
    const currentHash = digest(currentBytes);
    if (currentHash === sourceHash) {
      nextPages[page] = { source_sha256: sourceHash, installed_sha256: sourceHash };
      result.unchanged.push(destinationRelative);
      continue;
    }

    if (previous !== undefined && currentHash === previous.installed_sha256) {
      const backup = await preservedPath(projectRoot, backupRoot, destinationRelative, 'backup', currentBytes);
      await writeAtomic(projectRoot, destination, sourceBytes);
      nextPages[page] = { source_sha256: sourceHash, installed_sha256: sourceHash };
      result.backups.push({ destination: destinationRelative, backup });
      result.updated.push(destinationRelative);
      continue;
    }

    const candidate = await preservedPath(projectRoot, conflictRoot, destinationRelative, 'candidate', sourceBytes);
    result.conflicts.push({ destination: destinationRelative, candidate });
  }

  await writeAtomic(
    projectRoot,
    manifestPath,
    Buffer.from(`${JSON.stringify({ ...manifest, pages: nextPages }, null, 2)}\n`, 'utf8'),
  );
  return result;
}

/** Normalize a case wiki path and confine it to the project-owned namespace. */
export function normalizeProjectWikiPath(value: string): string {
  if (value === '' || value !== value.trim() || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`project wiki path is not normalized: ${value}`);
  }
  const components = value.split('/');
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new Error(`project wiki path contains an unsafe component: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (!normalized.startsWith(BENCHMARK_PROJECT_WIKI_PREFIX) || normalized === BENCHMARK_PROJECT_WIKI_PREFIX.slice(0, -1)) {
    throw new Error(`project wiki path must be under ${BENCHMARK_PROJECT_WIKI_PREFIX}`);
  }
  if (!normalized.endsWith('.md')) throw new Error(`project wiki path must name a Markdown file: ${value}`);
  return normalized;
}

async function runLinter(linter: string, file: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(linter, ['--file', file], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `Juno wiki_contract lint failed for ${file} (${code ?? signal ?? 'unknown'}): ` +
        `${Buffer.concat(stdout)}${Buffer.concat(stderr)}`.trim(),
      ));
    });
  });
}

/** Lint selected project pages through YYLO's public script, then hash exact bytes. */
export async function hashProjectWikis(
  paths: readonly string[],
  options: HashProjectWikisOptions,
): Promise<SelectedProjectWiki[]> {
  const projectRoot = path.resolve(options.projectRoot);
  const wikiRoot = path.join(projectRoot, '.juno_task', 'wiki');
  const linter = path.resolve(projectRoot, options.linter ?? '.juno_task/scripts/wiki_lint.sh');
  const normalized = [...new Set(paths.map(normalizeProjectWikiPath))].sort();
  const results: SelectedProjectWiki[] = [];

  for (const selected of normalized) {
    const absolute = path.join(wikiRoot, ...selected.split('/'));
    const relative = path.relative(wikiRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`project wiki path escapes wiki namespace: ${selected}`);
    }
    let current = projectRoot;
    const relativeToProject = path.relative(projectRoot, absolute);
    for (const component of relativeToProject.split(path.sep)) {
      current = path.join(current, component);
      const currentEntry = await entry(current);
      if (currentEntry === null) throw new Error(`selected project wiki does not exist: ${selected}`);
      if (currentEntry.isSymbolicLink()) throw new Error(`selected project wiki path contains a symbolic link: ${selected}`);
    }
    const fileEntry = await entry(absolute);
    if (fileEntry === null || !fileEntry.isFile()) {
      throw new Error(`selected project wiki is not a regular file: ${selected}`);
    }
    const beforeLint = await readFile(absolute);
    await runLinter(linter, absolute, projectRoot);
    const afterLint = await readFile(absolute);
    if (digest(beforeLint) !== digest(afterLint)) {
      throw new Error(`selected project wiki changed while it was being linted: ${selected}`);
    }
    results.push({ path: selected, sha256: `sha256:${digest(afterLint)}` });
  }
  return results;
}

export const lintAndHashProjectWikis = hashProjectWikis;
