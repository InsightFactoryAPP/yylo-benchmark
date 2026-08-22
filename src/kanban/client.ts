import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { LoadedConfig } from '../config/index.js';
import { resolveKanbanCommand } from '../config/index.js';
import { canonicalJson } from '../contracts/canonical.js';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const revision = z.string().regex(/^[0-9a-f]{64}$/u);

const KanbanTaskSchema = z.object({
  id: z.string().min(1), status: z.string().min(1), body: z.string(),
  last_modified: z.string().min(1), commit_hash: z.string().nullable().optional(),
  feature_tags: z.array(z.string()),
  related_tasks: z.preprocess((value) => value === null ? [] : value, z.array(z.string()).default([])),
  blocked_by: z.preprocess((value) => value === null ? [] : value, z.array(z.string()).default([])),
  fields: z.record(z.unknown()).default({}),
}).passthrough();
const HistoryEventSchema = z.object({
  task_id: z.string().min(1), operation: z.string().min(1),
  after_sha256: revision, event_id: z.string().min(1),
}).passthrough();
const MutationReceiptSchema = z.object({
  task_id: z.string().min(1), operation: z.string().min(1),
  before_sha256: revision.nullable(), after_sha256: revision,
  ledger_event_id: z.string().min(1), changed_paths: z.array(z.string()),
  persisted_path: z.string().min(1),
}).strict();

export type KanbanTask = z.infer<typeof KanbanTaskSchema>;
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>;
export interface RevisionedTask { readonly task: KanbanTask; readonly revision: string }
export interface CanonicalRecord { readonly task: KanbanTask; readonly receipt: MutationReceipt }
export interface BenchmarkRecordInput {
  readonly kind: 'experiment' | 'investigation';
  readonly sourceTaskId: string;
  readonly sourceRevision: string;
  readonly recordId: string;
  readonly benchmark: Readonly<Record<string, unknown>>;
  readonly title?: string;
}

function arrayFromJson(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null && Array.isArray((value as { tasks?: unknown }).tasks)) {
    return (value as { tasks: unknown[] }).tasks;
  }
  throw new Error(`public Kanban CLI returned JSON without a ${label} array`);
}
function assertTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(taskId)) throw new Error(`invalid task ID: ${taskId}`);
}

export class PublicKanbanClient {
  public constructor(private readonly loaded: LoadedConfig) {}

  private async invoke(arguments_: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const command = await resolveKanbanCommand(this.loaded);
    const child = spawn(command.executable, [...command.arguments, ...arguments_], {
      cwd: command.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let outputBytes = 0; let overflow = false;
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_JSON_BYTES) { overflow = true; child.kill('SIGKILL'); } else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    let timedOut = false; let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000); }, DEFAULT_TIMEOUT_MS);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => { clearTimeout(timeout); if (forceKill !== undefined) clearTimeout(forceKill); });
    if (overflow) throw new Error(`public Kanban CLI output exceeded ${MAX_JSON_BYTES} bytes`);
    if (timedOut) throw new Error(`public Kanban CLI timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    const out = Buffer.concat(stdout).toString('utf8').trim();
    const errorText = Buffer.concat(stderr).toString('utf8').trim();
    if (result.code !== 0) throw new Error(`public Kanban CLI failed (${result.code ?? result.signal ?? 'unknown'}): ${errorText || 'no stderr'}`);
    return { stdout: out, stderr: errorText };
  }

  private async invokeJson(arguments_: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    // argparse treats -f/--format as a global option, so it must precede the
    // public Kanban subcommand (for example: `-f json get TASK`).
    return this.invoke(['-f', 'json', ...arguments_]);
  }

  private parseJson(text: string): unknown {
    try { return JSON.parse(text) as unknown; }
    catch (error) { throw new Error(`public Kanban CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }

  public async assertCompatibleVersion(): Promise<string> {
    const { stdout } = await this.invoke(['--version']);
    const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:rc\d+)?(?:\s|$)/u.exec(stdout);
    if (match === null || Number(match[1]) !== 0 || Number(match[2]) !== 1) {
      throw new Error(`unsupported YYLO Ledger version: ${stdout || 'unknown'} (required >=0.1.0rc1,<0.2.0)`);
    }
    return stdout.trim().split(/\s/u).at(-1) ?? `${match[1]}.${match[2]}.${match[3]}`;
  }

  public async getTask(taskId: string): Promise<KanbanTask> {
    assertTaskId(taskId);
    const { stdout } = await this.invokeJson(['get', taskId]);
    const tasks = arrayFromJson(this.parseJson(stdout), 'task').map((item) => KanbanTaskSchema.parse(item));
    if (tasks.length !== 1 || tasks[0]?.id !== taskId) throw new Error(`public Kanban CLI returned ${tasks.length} tasks instead of exactly ${taskId}`);
    return tasks[0];
  }

  private async latestRevision(taskId: string): Promise<string> {
    const { stdout } = await this.invokeJson(['history', taskId, '--limit', '1']);
    const events = arrayFromJson(this.parseJson(stdout), 'history event').map((item) => HistoryEventSchema.parse(item));
    if (events.length !== 1 || events[0]?.task_id !== taskId) throw new Error(`public Kanban CLI has no exact revision for ${taskId}`);
    return events[0].after_sha256;
  }

  /** Double-reads the public ledger revision so task JSON and revision cannot straddle a concurrent mutation. */
  public async getRevisionedTask(taskId: string): Promise<RevisionedTask> {
    assertTaskId(taskId); await this.assertCompatibleVersion();
    const before = await this.latestRevision(taskId);
    const task = await this.getTask(taskId);
    const after = await this.latestRevision(taskId);
    if (before !== after) throw new Error(`task ${taskId} changed concurrently while it was read`);
    return { task, revision: after };
  }

  private async readReceipt(receiptPath: string): Promise<MutationReceipt> {
    let value: unknown;
    try { value = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown; }
    catch (error) { throw new Error(`public Kanban mutation did not produce a valid receipt: ${error instanceof Error ? error.message : String(error)}`); }
    return MutationReceiptSchema.parse(value);
  }

  private async mutate(args: readonly string[], expected: { operation: string; before: string | null }): Promise<CanonicalRecord> {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-kanban-'));
    const receiptPath = path.join(temporary, 'receipt.json');
    try {
      const { stdout } = await this.invokeJson([...args, '--receipt-file', receiptPath]);
      const receipt = await this.readReceipt(receiptPath);
      if (receipt.operation !== expected.operation || receipt.before_sha256 !== expected.before) throw new Error('public Kanban receipt does not bind the requested mutation');
      const tasks = arrayFromJson(this.parseJson(stdout), 'task').map((item) => KanbanTaskSchema.parse(item));
      const task = tasks.length === 1 ? tasks[0] : undefined;
      if (task === undefined || task.id !== receipt.task_id) throw new Error('public Kanban mutation output and receipt disagree');
      const current = await this.latestRevision(task.id);
      if (current !== receipt.after_sha256) throw new Error(`task ${task.id} changed concurrently after mutation`);
      return { task, receipt };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  public async listRelatedRecords(kind: BenchmarkRecordInput['kind'], sourceTaskId: string): Promise<readonly RevisionedTask[]> {
    assertTaskId(sourceTaskId); await this.assertCompatibleVersion();
    const tag = kind === 'experiment' ? 'benchmark-experiment' : 'benchmark-investigation';
    const { stdout } = await this.invokeJson(['search', '--tag', tag, '--field', `benchmark.source_task_id=${sourceTaskId}`, '--limit', '1000', '--projection', 'full']);
    const tasks = arrayFromJson(this.parseJson(stdout), 'task').map((item) => KanbanTaskSchema.parse(item))
      .filter((task) => task.feature_tags.includes(tag) && task.related_tasks.includes(sourceTaskId));
    if (tasks.length >= 1000) throw new Error(`related ${kind} discovery reached its 1000-record safety bound`);
    const unique = new Set(tasks.map((task) => task.id));
    if (unique.size !== tasks.length) throw new Error(`public Kanban CLI returned duplicate related ${kind} records`);
    return Promise.all(tasks.sort((left, right) => left.id.localeCompare(right.id)).map((task) => this.getRevisionedTask(task.id)));
  }

  public async findRelatedRecord(input: Pick<BenchmarkRecordInput, 'kind' | 'sourceTaskId' | 'recordId'>): Promise<RevisionedTask | null> {
    assertTaskId(input.sourceTaskId); await this.assertCompatibleVersion();
    const tag = input.kind === 'experiment' ? 'benchmark-experiment' : 'benchmark-investigation';
    const { stdout } = await this.invokeJson(['search', '--tag', tag, '--field', `benchmark.record_id=${input.recordId}`, '--limit', '2', '--projection', 'full']);
    const tasks = arrayFromJson(this.parseJson(stdout), 'task').map((item) => KanbanTaskSchema.parse(item));
    const matches = tasks.filter((task) => task.related_tasks.includes(input.sourceTaskId));
    if (matches.length > 1) throw new Error(`multiple canonical ${input.kind} records exist for ${input.recordId}`);
    return matches[0] === undefined ? null : this.getRevisionedTask(matches[0].id);
  }

  public async createRelatedRecord(input: BenchmarkRecordInput): Promise<CanonicalRecord> {
    assertTaskId(input.sourceTaskId); await this.assertCompatibleVersion();
    const source = await this.getRevisionedTask(input.sourceTaskId);
    if (source.revision !== input.sourceRevision) throw new Error(`stale source task revision for ${input.sourceTaskId}: expected ${input.sourceRevision}, current ${source.revision}`);
    const tag = input.kind === 'experiment' ? 'benchmark-experiment' : 'benchmark-investigation';
    const body = canonicalJson({ schema_version: 'juno_benchmark_record_body.v1', kind: input.kind, record_id: input.recordId, source_task_id: input.sourceTaskId, source_revision: input.sourceRevision });
    return this.mutate([
      'create', '--title', input.title ?? `Benchmark ${input.kind} ${input.recordId}`,
      '--body', body, '--status', 'backlog', '--tags', tag,
      '--related-tasks', input.sourceTaskId, '--field', `benchmark=${canonicalJson(input.benchmark)}`,
      '--reject-duplicates',
    ], { operation: 'create', before: null });
  }

  public async updateBenchmarkField(taskId: string, expectedRevision: string, benchmark: Readonly<Record<string, unknown>>): Promise<CanonicalRecord> {
    assertTaskId(taskId); revision.parse(expectedRevision); await this.assertCompatibleVersion();
    return this.mutate(['update', taskId, '--expected-revision', expectedRevision, '--field', `benchmark=${canonicalJson(benchmark)}`], { operation: 'update', before: expectedRevision });
  }
}
