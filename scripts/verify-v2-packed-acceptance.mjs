#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const tarball = process.argv[2];
if (!tarball) throw new Error('usage: verify-v2-packed-acceptance.mjs /absolute/package.tgz');
const root = await mkdtemp(path.join(os.tmpdir(), 'yylo-benchmark-v2-packed-'));
await writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}\n');
await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.resolve(tarball)], { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
await mkdir(path.join(root, 'case'));
await writeFile(path.join(root, 'case', 'task.md'), 'inspect without dispatch\n');
await exec('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: root });
await exec('git', ['config', 'user.name', 'Packed Acceptance'], { cwd: root });
await exec('git', ['config', 'user.email', 'packed@example.invalid'], { cwd: root });
await exec('git', ['add', 'case/task.md'], { cwd: root });
await exec('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
const executable = path.join(root, 'node_modules', '.bin', 'yylo-benchmark');
const run = async (args) => await exec(executable, args, { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
const help = (await run(['--help'])).stdout;
for (const command of ['plan', 'run', 'recover', 'regrade', 'rejudge', 'doctor', 'report']) {
  if (!new RegExp(`\\b${command}\\b`, 'u').test(help)) throw new Error(`packed help omits ${command}`);
}
await run(['init']);
const configPath = path.join(root, 'yylo-benchmark.config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.yylo_version = 'packed-no-dispatch';
await writeFile(configPath, `${JSON.stringify(config)}\n`);
const plan = JSON.parse((await run(['plan', '--task', 'case/task.md', '--models', 'offline/vendor-model', '--output', 'plan.json'])).stdout);
if (plan.schema_version !== 'yylo_benchmark_experiment_plan.v2' || JSON.stringify(plan).includes('juno_version')) throw new Error('packed plan is not canonical v2');
const dryRun = JSON.parse((await run(['run', '--plan', 'plan.json', '--dry-run'])).stdout);
if (dryRun.dispatch_count !== 0) throw new Error('packed dry-run dispatched work');
let doctorFailure;
try { await run(['doctor', '--plan', 'plan.json']); throw new Error('packed doctor accepted a plan with no retained attempt chain'); }
catch (error) { doctorFailure = error; }
if (!/planned attempt chain is incomplete/iu.test(`${doctorFailure.stderr ?? ''}${doctorFailure.message ?? ''}`)) throw new Error('packed doctor did not fail closed on missing planned evidence');
let reportFailure;
try { await run(['report', '--plan', 'plan.json']); throw new Error('packed report accepted a plan with no retained attempt chain'); }
catch (error) { reportFailure = error; }
if (!/planned attempt chain is incomplete/iu.test(`${reportFailure.stderr ?? ''}${reportFailure.message ?? ''}`)) throw new Error('packed report did not fail closed on missing planned evidence');
const combined = JSON.stringify({ plan, dryRun });
if (/authorization|max_usd|spend|juno_version/iu.test(combined)) throw new Error('packed v2 output contains retired controls or branding');
process.stdout.write(`${JSON.stringify({ schema_version: 'yylo_benchmark_packed_acceptance.v2', ok: true, dispatch_count: 0, root })}\n`);
