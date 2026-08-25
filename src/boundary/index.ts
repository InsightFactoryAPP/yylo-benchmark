import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalHash, canonicalJson } from '../contracts/canonical.js';
import { ImmutableArtifactRegistry } from '../registry/index.js';
import { createReviewedBoundaryReadinessProbe, WORKFLOW_PROCESS_BOUNDARY_PROTOCOL } from '../workflow/runtime.js';

export const BOUNDARY_SETUP_SCHEMA_VERSION = 'juno_benchmark_boundary_setup.v1' as const;
export const BOUNDARY_SETUP_FILENAME = 'yylo-benchmark.boundary.json';
export const BOUNDARY_READINESS_SCHEMA_VERSION = 'juno_benchmark_workflow_readiness.v1' as const;
export const BOUNDARY_SUPPORTED_OPERATIONS = Object.freeze(['probe', 'preflight', 'dispatch', 'reconcile', 'resume', 'judge']);
export const BOUNDARY_SUPPORTED_PROVIDERS = Object.freeze(['openai-codex', 'zai']);

const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const nonEmpty = z.string().trim().min(1);

export const BoundarySetupSchema = z.object({
  schema_version: z.literal(BOUNDARY_SETUP_SCHEMA_VERSION),
  boundary: z.object({
    path: nonEmpty,
    sha256: z.string().regex(sha256Pattern),
    protocol: z.literal(WORKFLOW_PROCESS_BOUNDARY_PROTOCOL),
  }).strict(),
  registry: z.object({ backend: z.literal('local'), root: nonEmpty }).strict(),
  providers: z.array(nonEmpty).min(1),
  synthetic: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
}).strict();
export type BoundarySetup = z.infer<typeof BoundarySetupSchema>;

export interface BoundarySetupReceipt {
  readonly schema_version: 'juno_benchmark_boundary_setup_receipt.v1';
  readonly boundary: { readonly path: string; readonly sha256: `sha256:${string}`; readonly protocol: typeof WORKFLOW_PROCESS_BOUNDARY_PROTOCOL };
  readonly registry: { readonly backend: 'local'; readonly root: string };
  readonly providers: readonly string[];
  readonly synthetic: boolean;
  readonly environment: { readonly YYLO_BENCHMARK_WORKFLOW_BOUNDARY: string; readonly YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: string };
}

/**
 * Absolute path of the packaged reviewed boundary module. The CLI bundles at
 * different depths (dist/bin.js, dist/boundary/index.js, src), so resolve by
 * walking up to the package root identified by package.json and never beyond
 * the installed package.
 */
export function packagedBoundaryModulePath(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, 'boundary', 'yylo-workflow-boundary.mjs');
    if (existsSync(candidate)) return candidate;
    if (existsSync(path.join(directory, 'package.json'))) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('packaged reviewed workflow boundary module is missing from the installed package');
}

export async function packagedBoundaryBytes(): Promise<Buffer> {
  return readFile(packagedBoundaryModulePath());
}

export function boundarySha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Registry root resolution shared with workflow storage so setup never forks the truth. */
export function resolveWorkflowRegistryRoot(projectRoot: string): string {
  const fromEnvironment = process.env['YYLO_BENCHMARK_REGISTRY']?.trim();
  if (fromEnvironment !== undefined && fromEnvironment !== '') return path.resolve(fromEnvironment);
  return path.join(projectRoot, '.juno_task', 'artifacts', 'yylo-benchmark');
}

export async function installReviewedBoundary(input: {
  readonly projectRoot: string;
  readonly providers: readonly string[];
  readonly synthetic: boolean;
}): Promise<BoundarySetupReceipt> {
  for (const provider of input.providers) {
    if (!BOUNDARY_SUPPORTED_PROVIDERS.includes(provider)) throw new Error(`unsupported boundary provider ${provider}; supported: ${BOUNDARY_SUPPORTED_PROVIDERS.join(', ')}`);
  }
  if (new Set(input.providers).size !== input.providers.length) throw new Error('boundary providers must be unique');
  const bytes = await packagedBoundaryBytes();
  const digest = boundarySha256Hex(bytes);
  const destinationDirectory = path.join(input.projectRoot, '.juno_task', 'boundary');
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(destinationDirectory, 'yylo-workflow-boundary.mjs');
  const existing = await readFile(destination).catch(() => null);
  if (existing === null) await writeFile(destination, bytes, { mode: 0o400, flag: 'wx' });
  else if (boundarySha256Hex(existing) !== digest) {
    throw new Error(`boundary module at ${destination} has different bytes; remove it explicitly before installing a new reviewed boundary`);
  }
  await chmod(destination, 0o400);
  const metadata = await stat(destination);
  if (!metadata.isFile() || metadata.mode & 0o222) throw new Error('installed boundary module must be a read-only regular file');
  // The reviewed-module contract requires an exact non-symlinked absolute
  // path, so the record binds the canonical realpath of the install site.
  const canonicalDestination = await realpath(destination);
  const registryRoot = resolveWorkflowRegistryRoot(input.projectRoot);
  const registry = new ImmutableArtifactRegistry(registryRoot);
  await registry.initialize();
  const setup: BoundarySetup = {
    schema_version: BOUNDARY_SETUP_SCHEMA_VERSION,
    boundary: { path: canonicalDestination, sha256: `sha256:${digest}` as `sha256:${string}`, protocol: WORKFLOW_PROCESS_BOUNDARY_PROTOCOL },
    registry: { backend: 'local', root: registryRoot },
    providers: [...input.providers],
    synthetic: input.synthetic,
    created_at: new Date().toISOString(),
  };
  await writeFile(path.join(input.projectRoot, BOUNDARY_SETUP_FILENAME), `${canonicalJson(setup)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    schema_version: 'juno_benchmark_boundary_setup_receipt.v1',
    boundary: { path: canonicalDestination, sha256: `sha256:${digest}` as `sha256:${string}`, protocol: WORKFLOW_PROCESS_BOUNDARY_PROTOCOL },
    registry: setup.registry, providers: setup.providers, synthetic: setup.synthetic,
    environment: { YYLO_BENCHMARK_WORKFLOW_BOUNDARY: canonicalDestination, YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256: digest },
  };
}

export async function loadBoundarySetup(projectRoot: string): Promise<BoundarySetup> {
  const raw = await readFile(path.join(projectRoot, BOUNDARY_SETUP_FILENAME), 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`malformed boundary setup record: ${error instanceof Error ? error.message : String(error)}`); }
  return BoundarySetupSchema.parse(parsed);
}

/** Verify the installed boundary bytes against the setup record, failing closed on drift. */
export async function verifyBoundarySetup(projectRoot: string): Promise<{ readonly setup: BoundarySetup; readonly bytes: Buffer }> {
  const setup = await loadBoundarySetup(projectRoot);
  const bytes = await readFile(setup.boundary.path).catch(() => { throw new Error(`installed boundary module is missing: ${setup.boundary.path}`); });
  const digest = boundarySha256Hex(bytes);
  if (digest !== setup.boundary.sha256.replace(/^sha256:/u, '')) throw new Error('installed boundary module bytes drifted from the reviewed setup digest');
  const metadata = await stat(setup.boundary.path);
  if (!metadata.isFile() || metadata.mode & 0o222) throw new Error('installed boundary module must remain a read-only regular file');
  return { setup, bytes };
}

export interface BoundaryReadinessInput {
  readonly projectRoot: string;
  readonly models: readonly { readonly selector: string; readonly model: string; readonly provider: string }[];
}

export interface BoundaryReadinessReceipt {
  readonly schema_version: typeof BOUNDARY_READINESS_SCHEMA_VERSION;
  readonly boundary: { readonly path: string; readonly sha256: `sha256:${string}`; readonly protocol: typeof WORKFLOW_PROCESS_BOUNDARY_PROTOCOL; readonly transport: 'live' | 'synthetic' };
  readonly operations: readonly string[];
  readonly providers: readonly string[];
  readonly models: readonly { readonly selector: string; readonly model: string; readonly provider: string; readonly authenticated: boolean }[];
  readonly yylo: { readonly executable: string; readonly version: string };
  readonly registry: { readonly backend: 'local'; readonly root: string };
  readonly dispatch_count: 0;
  readonly generated_at: string;
  readonly receipt_hash: `sha256:${string}`;
}

/** Produce and retain a zero-dispatch readiness receipt for exact model selectors. */
export async function generateBoundaryReadiness(input: BoundaryReadinessInput & {
  readonly junoVersion: string;
  readonly junoExecutable: string;
}): Promise<{ readonly receipt: BoundaryReadinessReceipt; readonly registry: ImmutableArtifactRegistry }> {
  const { setup } = await verifyBoundarySetup(input.projectRoot);
  const liveRegistryRoot = resolveWorkflowRegistryRoot(input.projectRoot);
  if (liveRegistryRoot !== setup.registry.root) {
    throw new Error(`live registry root ${liveRegistryRoot} does not match the setup record ${setup.registry.root}; align YYLO_BENCHMARK_REGISTRY before readiness`);
  }
  if (setup.synthetic) process.env['YYLO_BENCHMARK_BOUNDARY_SYNTHETIC'] = '1';
  const transport: 'live' | 'synthetic' = process.env['YYLO_BENCHMARK_BOUNDARY_SYNTHETIC'] === '1' ? 'synthetic' : 'live';
  const probe = await createReviewedBoundaryReadinessProbe({
    module: setup.boundary.path, sha256: setup.boundary.sha256.replace(/^sha256:/u, ''),
  });
  if (canonicalHash([...probe.providers].sort()) !== canonicalHash([...setup.providers].sort())) {
    throw new Error('reviewed boundary providers drifted from the setup record');
  }
  for (const selection of input.models) {
    if (!probe.providers.includes(selection.provider)) throw new Error(`reviewed boundary has no credential route for provider ${selection.provider}`);
  }
  for (const selection of input.models) await probe.preflightIdentity({ provider: selection.provider, model: selection.model, junoVersion: input.junoVersion });
  const core = {
    schema_version: BOUNDARY_READINESS_SCHEMA_VERSION,
    boundary: { path: setup.boundary.path, sha256: setup.boundary.sha256 as `sha256:${string}`, protocol: WORKFLOW_PROCESS_BOUNDARY_PROTOCOL, transport },
    operations: BOUNDARY_SUPPORTED_OPERATIONS,
    providers: probe.providers,
    models: input.models.map((selection) => ({ selector: selection.selector, model: selection.model, provider: selection.provider, authenticated: true })),
    yylo: { executable: input.junoExecutable, version: input.junoVersion },
    registry: { backend: 'local' as const, root: setup.registry.root },
    dispatch_count: 0 as const,
    generated_at: new Date().toISOString(),
  };
  const receipt: BoundaryReadinessReceipt = { ...core, receipt_hash: canonicalHash(core) as `sha256:${string}` };
  const registry = new ImmutableArtifactRegistry(setup.registry.root);
  const reference = await registry.put('boundary-readiness-receipt', `${canonicalJson(receipt)}\n`);
  await registry.append('boundary-readiness', reference);
  return { receipt, registry };
}
