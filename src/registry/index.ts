import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../contracts/canonical.js';

export interface ArtifactReference {
  readonly schema_version: 'juno_benchmark_artifact_ref.v1';
  readonly role: string;
  readonly backend: 'local';
  readonly path: string;
  readonly size: number;
  readonly sha256: `sha256:${string}`;
}
export interface ManifestEntry extends ArtifactReference {
  readonly sequence: number;
  readonly recorded_at: string;
  readonly previous_entry_hash: `sha256:${string}` | null;
  readonly entry_hash: `sha256:${string}`;
}
interface Manifest {
  schema_version: 'juno_benchmark_experiment_manifest.v1';
  experiment_id: string;
  entries: ManifestEntry[];
}

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === '.' || value === '..') throw new Error(`invalid ${label}: ${value}`);
}
function privateMode(mode: number, allowed: number, label: string): void {
  if ((mode & 0o077) !== 0 || (mode & 0o700) > allowed) throw new Error(`${label} permissions are not private`);
}

export class ImmutableArtifactRegistry {
  readonly #root: string;
  public constructor(root: string) { this.#root = path.resolve(root); }

  public get root(): string { return this.#root; }

  private async ensurePrivateDirectory(destination: string): Promise<void> {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const metadata = await lstat(destination);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`registry path is not a real directory: ${destination}`);
    await chmod(destination, 0o700);
  }

  public async initialize(): Promise<void> {
    await this.ensurePrivateDirectory(this.#root);
    for (const item of ['objects', 'objects/sha256', 'experiments', 'cases', '.locks', '.tmp']) {
      await this.ensurePrivateDirectory(path.join(this.#root, item));
    }
  }

  private objectPath(digest: string): string { return path.join(this.#root, 'objects', 'sha256', digest); }

  public async put(role: string, bytes: Uint8Array | string): Promise<ArtifactReference> {
    safeId(role, 'artifact role'); await this.initialize();
    const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
    const digest = sha256Hex(data); const destination = this.objectPath(digest);
    const temporary = path.join(this.#root, '.tmp', `${digest}.${process.pid}.${Math.random().toString(16).slice(2)}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    let created = false;
    try { await link(temporary, destination); created = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally { await rm(temporary, { force: true }); }
    if (created) await chmod(destination, 0o400);
    const reference: ArtifactReference = {
      schema_version: 'juno_benchmark_artifact_ref.v1', role, backend: 'local',
      path: `objects/sha256/${digest}`, size: data.length, sha256: `sha256:${digest}`,
    };
    await this.read(reference);
    return Object.freeze(reference);
  }

  public async read(reference: ArtifactReference): Promise<Buffer> {
    if (reference.schema_version !== 'juno_benchmark_artifact_ref.v1' || reference.backend !== 'local') throw new Error('unsupported artifact reference');
    safeId(reference.role, 'artifact role');
    const digest = reference.sha256.replace(/^sha256:/u, '');
    if (!/^[0-9a-f]{64}$/u.test(digest) || reference.path !== `objects/sha256/${digest}`) throw new Error('artifact reference path/hash mismatch');
    const destination = this.objectPath(digest); const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('artifact object is not a regular file');
    privateMode(metadata.mode, 0o600, 'artifact object');
    const data = await readFile(destination);
    if (data.length !== reference.size || sha256Hex(data) !== digest) throw new Error(`artifact verification failed for ${reference.sha256}`);
    return data;
  }

  private async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    safeId(id, 'lock ID'); await this.initialize();
    const lock = path.join(this.#root, '.locks', id);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`concurrent registry writer for ${id}`); throw error; }
    try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
  }

  private async atomicJson(destination: string, value: unknown): Promise<void> {
    const temporary = path.join(this.#root, '.tmp', `${path.basename(destination)}.${process.pid}.${Math.random().toString(16).slice(2)}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(`${canonicalJson(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination); await chmod(destination, 0o600);
  }

  private async loadManifest(experimentId: string): Promise<Manifest> {
    const manifestPath = path.join(this.#root, 'experiments', experimentId, 'manifest.json');
    let value: unknown;
    try { value = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 'juno_benchmark_experiment_manifest.v1', experiment_id: experimentId, entries: [] }; throw error; }
    if (typeof value !== 'object' || value === null) throw new Error('invalid experiment manifest');
    const candidate = value as Partial<Manifest>;
    if (candidate.schema_version !== 'juno_benchmark_experiment_manifest.v1' || candidate.experiment_id !== experimentId || !Array.isArray(candidate.entries)) throw new Error('invalid experiment manifest identity');
    return candidate as Manifest;
  }

  public async append(experimentId: string, reference: ArtifactReference, recordedAt = new Date().toISOString()): Promise<ManifestEntry> {
    safeId(experimentId, 'experiment ID'); await this.read(reference);
    return this.withLock(`experiment-${experimentId}`, async () => {
      const directory = path.join(this.#root, 'experiments', experimentId); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      const manifest = await this.loadManifest(experimentId); await this.verifyEntries(manifest.entries);
      if (manifest.entries.some((entry) => entry.sha256 === reference.sha256 && entry.role === reference.role)) throw new Error('artifact role/hash is already recorded');
      const previous = manifest.entries.at(-1)?.entry_hash ?? null;
      const core = { ...reference, sequence: manifest.entries.length + 1, recorded_at: recordedAt, previous_entry_hash: previous };
      const entry = { ...core, entry_hash: `sha256:${sha256Hex(canonicalJson(core))}` as const };
      manifest.entries.push(entry); await this.atomicJson(path.join(directory, 'manifest.json'), manifest);
      return Object.freeze(entry);
    });
  }

  private async verifyEntries(entries: readonly ManifestEntry[]): Promise<void> {
    let previous: string | null = null;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const { entry_hash: claimed, ...core } = entry;
      if (entry.sequence !== index + 1 || entry.previous_entry_hash !== previous || claimed !== `sha256:${sha256Hex(canonicalJson(core))}`) throw new Error('experiment manifest append chain is invalid');
      await this.read(entry); previous = claimed;
    }
  }

  public async verifyExperiment(experimentId: string): Promise<readonly ManifestEntry[]> {
    safeId(experimentId, 'experiment ID'); const manifest = await this.loadManifest(experimentId); await this.verifyEntries(manifest.entries);
    return Object.freeze([...manifest.entries]);
  }

  public async writeCaseIndex(taskId: string, experimentId: string, compact: Readonly<Record<string, unknown>>): Promise<void> {
    safeId(taskId, 'task ID'); safeId(experimentId, 'experiment ID');
    await this.withLock(`case-${taskId}`, async () => {
      const destination = path.join(this.#root, 'cases', taskId, 'index.json');
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await chmod(path.dirname(destination), 0o700);
      let entries: unknown[] = [];
      try { const parsed = JSON.parse(await readFile(destination, 'utf8')) as { entries?: unknown }; if (!Array.isArray(parsed.entries)) throw new Error('invalid case index'); entries = parsed.entries; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (entries.some((item) => typeof item === 'object' && item !== null && (item as { experiment_id?: unknown }).experiment_id === experimentId)) throw new Error(`case index already contains ${experimentId}`);
      entries.push({ experiment_id: experimentId, ...compact });
      await this.atomicJson(destination, { schema_version: 'juno_benchmark_case_index.v1', task_id: taskId, entries });
    });
  }

  public async readCaseIndex(taskId: string): Promise<Readonly<Record<string, unknown>>> {
    safeId(taskId, 'task ID');
    const value = JSON.parse(await readFile(path.join(this.#root, 'cases', taskId, 'index.json'), 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null) throw new Error('invalid case index');
    const index = value as { schema_version?: unknown; task_id?: unknown; entries?: unknown };
    if (index.schema_version !== 'juno_benchmark_case_index.v1' || index.task_id !== taskId || !Array.isArray(index.entries)) throw new Error('invalid case index identity');
    return Object.freeze(value as Readonly<Record<string, unknown>>);
  }

  public async doctor(): Promise<void> {
    const root = await stat(this.#root); privateMode(root.mode, 0o700, 'registry root');
    for (const directory of ['objects/sha256', 'experiments', 'cases', '.locks', '.tmp']) {
      const metadata = await lstat(path.join(this.#root, directory));
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`registry directory is unsafe: ${directory}`);
      privateMode(metadata.mode, 0o700, `${directory} directory`);
    }
    const objects = await readdir(path.join(this.#root, 'objects', 'sha256'));
    for (const digest of objects) {
      if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error(`invalid registry object name: ${digest}`);
      const destination = this.objectPath(digest); const metadata = await lstat(destination);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`registry object is unsafe: ${digest}`);
      privateMode(metadata.mode, 0o600, 'artifact object');
      if (sha256Hex(await readFile(destination)) !== digest) throw new Error(`registry object hash mismatch: ${digest}`);
    }
    const experimentIds = await readdir(path.join(this.#root, 'experiments'));
    for (const experimentId of experimentIds) await this.verifyExperiment(experimentId);
  }
}
