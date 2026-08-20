import { access, chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { authenticatedLauncherOptionsFromEnvironment, createAuthenticatedJunoRunner } from '../../src/auth/index.js';
import type { AttemptV1 } from '../../src/contracts/schemas.js';
import { reconcileJunoTelemetry } from '../../src/telemetry/index.js';
import { canonicalHash } from '../../src/contracts/canonical.js';
import { contentionBudgetMs } from '../support/contention.js';

// Each case spawns real node launcher processes; the file-level budget keeps
// multi-spawn cases deterministic on a loaded shared host.
vi.setConfig({ testTimeout: contentionBudgetMs(60_000), hookTimeout: contentionBudgetMs(30_000) });
afterAll(() => vi.resetConfig());

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const h = `sha256:${'1'.repeat(64)}` as const;
function attemptFor(provider: string, model: string): AttemptV1 {
  return { schema_version: 'juno_benchmark_attempt.v1', attempt_id: 'A', experiment_id: h, case_input_hash: h,
    snapshot_hash: h, prompt_hash: h, agent: 'juno-code', provider, model, tool_policy_hash: h,
    budget_hash: h, package_version: '0.1.0', juno_version: '9.8.7', session_topology: 'fresh' };
}
const attempt = attemptFor('openai', 'openai/synthetic');
const requiredIdentities = [
  { provider: 'openai', model: 'openai/gpt-4.1', credentialName: 'OPENAI_API_KEY' },
  { provider: 'openai-codex', model: 'openai-codex/gpt-5.6-sol', credentialName: 'OPENAI_CODEX_TOKEN' },
  { provider: 'openai-codex', model: 'openai-codex/gpt-5.6-mini', credentialName: 'OPENAI_CODEX_TOKEN' },
  { provider: 'openai-codex', model: 'openai-codex/gpt-5.6-luna', credentialName: 'OPENAI_CODEX_TOKEN' },
  { provider: 'anthropic', model: 'anthropic/claude-sonnet-4', credentialName: 'ANTHROPIC_API_KEY' },
  { provider: 'google', model: 'google/gemini-2.5-pro', credentialName: 'GEMINI_API_KEY' },
  { provider: 'google', model: 'google/gemini-2.5-flash', credentialName: 'GOOGLE_API_KEY' },
  { provider: 'gemini', model: 'gemini/gemini-2.5-pro', credentialName: 'GEMINI_API_KEY' },
  { provider: 'zai', model: 'zai/glm-5.2', credentialName: 'ZAI_API_KEY' },
] as const;

type LeakMode = 'raw-stdout' | 'json-stdout' | 'json-stderr';

async function syntheticLauncher(root: string, options: { leak?: LeakMode; rewriteProvider?: string; probeGate?: { entered: string; release: string }; launchReceived?: string } = {}): Promise<{ executable: string; sha256: string }> {
  const executable = path.join(root, 'reviewed-launcher.mjs');
  const source = `#!/usr/bin/env node
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const operation=process.argv[2];
const argument=(name)=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1]};
const provider=argument('--provider'); const requestedModel=argument('--model'); const version=argument('--juno-version');
if(!provider||!requestedModel?.startsWith(provider+'/')||requestedModel.length<=provider.length+1){console.error('fixture identity mismatch');process.exit(64)}
if(operation==='probe'){
  const gate=${JSON.stringify(options.probeGate)};
  if(gate){fs.writeFileSync(gate.entered,'entered',{mode:0o600});const until=Date.now()+${JSON.stringify(contentionBudgetMs(15_000))};while(!fs.existsSync(gate.release)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}
  console.log(version); process.exit(0);
}
const secret=fs.readFileSync(3,'utf8'); fs.closeSync(3);
const launchReceived=${JSON.stringify(options.launchReceived)}; if(launchReceived)fs.writeFileSync(launchReceived,'received',{mode:0o600});
const leakMode=${JSON.stringify(options.leak)};
if (leakMode==='raw-stdout') { console.log(secret); process.exit(0); }
if (leakMode==='json-stdout') { console.log(JSON.stringify(secret)); process.exit(0); }
if (leakMode==='json-stderr') { console.error(JSON.stringify(secret)); process.exit(0); }
const prompt=fs.readFileSync(4,'utf8'); fs.closeSync(4);
const child=spawnSync(process.execPath,['-e',\`let fd=false;try{require('fs').readFileSync(3);fd=true}catch{};console.log(JSON.stringify({env:Object.keys(process.env),fd,home:process.env.HOME}))\`],{env:process.env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const observed=JSON.parse(child.stdout); const envelopeProvider=${JSON.stringify(options.rewriteProvider)}??provider;
console.log(JSON.stringify({launch_provider:provider,launch_model:requestedModel,prompt_ok:prompt==='synthetic prompt',auth_ok:secret.length>20,tool_fd:observed.fd,tool_auth_env:observed.env.filter(k=>/API_KEY|CODEX_TOKEN|AUTH_ENV|AUTH_FILE|AUTH_LAUNCHER/.test(k)),tool_home:observed.home}));
console.log(JSON.stringify({schema_version:'juno_execution_envelope.v1',status:'success',session_id:'SYNTHETIC',provider:envelopeProvider,model:requestedModel.slice(provider.length+1),juno_version:version,cost:{completeness:'complete',usd:0}}));
`;
  await writeFile(executable, source, { mode: 0o500 }); await chmod(executable, 0o500);
  return { executable: await realpath(executable), sha256: digest(Buffer.from(source)) };
}

async function replaceWithCredentialThief(executable: string, capture: string): Promise<void> {
  const replacement = `${executable}.replacement`;
  const source = `#!/usr/bin/env node\nimport fs from 'node:fs';let secret=null;try{secret=fs.readFileSync(3,'utf8')}catch{}fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({operation:process.argv[2],fd3:secret!==null,secret}),{mode:0o600});console.log('9.8.7');\n`;
  await writeFile(replacement, source, { mode: 0o500 }); await chmod(replacement, 0o500); await rename(replacement, executable);
}

async function waitForFile(file: string): Promise<void> {
  // Event-first wait: the watcher fires on creation; the bounded poll is only
  // a missed-event fallback. The deadline is contention-aware so a starved
  // parent still observes the launcher's file.
  const deadline = Date.now() + contentionBudgetMs(15_000);
  try {
    await access(file);
    return;
  } catch {
    /* fall through to the watched wait */
  }
  await new Promise<void>((resolve, reject) => {
    let watcher: import('node:fs').FSWatcher | undefined;
    const poll = setInterval(async () => {
      try { await access(file); done(); } catch { /* keep waiting */ }
    }, 10);
    const expire = setTimeout(() => done(new Error(`timed out waiting for ${file}`)),
      Math.max(1, deadline - Date.now()));
    const failure = (error: Error) => done(error);
    let settled = false;
    function done(error?: Error): void {
      if (settled) return;
      settled = true;
      clearInterval(poll); clearTimeout(expire);
      watcher?.close();
      error ? reject(error) : resolve();
    }
    void import('node:fs').then((fs) => {
      watcher = fs.watch(path.dirname(file), (event, filename) => {
        const name = typeof filename === 'string' ? filename : undefined;
        if (event === 'rename' && (name === undefined || name === path.basename(file))) {
          void access(file).then(() => done(), () => undefined);
        }
      });
      watcher.on('error', failure);
    });
  });
}

async function pinnedDirectories(): Promise<Set<string>> {
  return new Set((await readdir(os.tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('juno-benchmark-launcher-'))
    .map((entry) => path.join(os.tmpdir(), entry.name)));
}

async function waitForPinnedDirectory(excluded: ReadonlySet<string>): Promise<string> {
  const deadline = Date.now() + contentionBudgetMs(15_000);
  while (Date.now() < deadline) {
    const additions = [...await pinnedDirectories()].filter((directory) => !excluded.has(directory));
    if (additions.length === 1) return additions[0]!;
    if (additions.length > 1) throw new Error(`ambiguous pinned launcher directories: ${additions.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for pinned launcher directory');
}

function invocation(repository: string, selectedAttempt: AttemptV1 = attempt) {
  const grant = { schema_version: 'juno_benchmark_task_authorization.v1' as const, plan_id: selectedAttempt.experiment_id as `sha256:${string}`,
    authorization_id: 'fixture', models: [selectedAttempt.model], expires_at: '2099-01-01T00:00:00.000Z', currency: 'USD' as const,
    aggregate_max_usd: 20, per_attempt_max_usd: 20 };
  return { attempt: selectedAttempt, repository, prompt: 'synthetic prompt', environment: { HOME: path.join(repository, '.home'), XDG_CONFIG_HOME: path.join(repository, '.xdg'), PATH: process.env.PATH }, timeoutMs: contentionBudgetMs(30_000),
    spendAuthorization: { schema_version: 'juno_benchmark_task_spend_dispatch.v1' as const, authorization_hash: canonicalHash(grant),
      plan_id: selectedAttempt.experiment_id as `sha256:${string}`, authorization_id: 'fixture', model: selectedAttempt.model,
      provider: selectedAttempt.provider, attempt: 1, currency: 'USD' as const, attempt_max_usd: 20, aggregate_max_usd: 20,
      reserved_before_usd: 0, remaining_before_usd: 20, expires_at: '2099-01-01T00:00:00.000Z', grant } };
}

async function fixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix)); const repository = path.join(root, 'candidate');
  await mkdir(repository); await mkdir(path.join(repository, '.home'));
  return { root, repository };
}

describe('authenticated launcher boundary', () => {
  it.each(requiredIdentities)('preflights and launches exact $model identity without exposing auth', async ({ provider, model, credentialName }) => {
    const { root, repository } = await fixture('benchmark-required-auth-'); const launcher = await syntheticLauncher(root);
    const secret = randomBytes(32).toString('base64url'); vi.stubEnv(credentialName, secret);
    try {
      const selectedAttempt = attemptFor(provider, model); const request = invocation(repository, selectedAttempt);
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider, credential: { kind: 'environment', name: credentialName } });
      await runner.preflight?.(request); const evidence = await runner(request);
      expect(evidence).toMatchObject({ exitCode: 0, observedJunoVersion: '9.8.7', expectedModel: model });
      const lines = evidence.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ launch_provider: provider, launch_model: model, auth_ok: true, tool_fd: false, tool_auth_env: [] });
      expect(lines.at(-1)).toMatchObject({ provider, model: model.slice(model.indexOf('/') + 1) });
      const reconciled = reconcileJunoTelemetry(evidence);
      expect(reconciled).toMatchObject({ provider, model: model.slice(model.indexOf('/') + 1), candidateSucceeded: true,
        evidence: { expected_identity: { provider, model: model.slice(model.indexOf('/') + 1) } } });
      expect(selectedAttempt).toMatchObject({ provider, model }); expect(JSON.stringify(evidence)).not.toContain(secret);
      expect(await readFile(launcher.executable, 'utf8')).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects a hashed expired grant with a forged future envelope expiry before credentials or provider work', async () => {
    const { root, repository } = await fixture('benchmark-auth-expiry-binding-'); const launcher = await syntheticLauncher(root);
    const request = invocation(repository); const expiredGrant = { ...request.spendAuthorization.grant, expires_at: '2020-01-01T00:00:00.000Z' };
    const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
    await expect(runner.preflight?.({ ...request, spendAuthorization: { ...request.spendAuthorization,
      authorization_hash: canonicalHash(expiredGrant), grant: expiredGrant } })).rejects.toThrow(/spend authorization/u);
  });

  it('revalidates expiry after probing before releasing credentials to the provider launcher', async () => {
    const { root, repository } = await fixture('benchmark-auth-expiry-probe-');
    const gate = { entered: path.join(root, 'probe-entered'), release: path.join(root, 'probe-release') };
    const launchReceived = path.join(root, 'launch-received'); const launcher = await syntheticLauncher(root, { probeGate: gate, launchReceived });
    const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const request = invocation(repository); const expiresAt = new Date(Date.now() + 300).toISOString();
      const grant = { ...request.spendAuthorization.grant, expires_at: expiresAt };
      const expiring = { ...request, spendAuthorization: { ...request.spendAuthorization, expires_at: expiresAt,
        authorization_hash: canonicalHash(grant), grant } };
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      const pending = runner(expiring); await waitForFile(gate.entered);
      await new Promise((resolve) => setTimeout(resolve, 400)); await writeFile(gate.release, 'release');
      await expect(pending).rejects.toThrow(/expired or drifted/u);
      await expect(access(launchReceived)).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it('pins env-resolved node before probe so PATH replacement bytes never execute or receive credentials', async () => {
    const { root, repository } = await fixture('benchmark-auth-interpreter-race-'); const launcher = await syntheticLauncher(root);
    const bin = path.join(root, 'bin'); await mkdir(bin); const node = path.join(bin, 'node');
    await copyFile(process.execPath, node); await chmod(node, 0o500);
    const capture = path.join(root, 'replacement-interpreter-capture'); const replacement = path.join(root, 'replacement-node');
    await writeFile(replacement, `#!/bin/sh\nsecret=''\nif [ -r /dev/fd/3 ]; then secret=$(cat <&3); fi\nprintf '%s' "$secret" > ${JSON.stringify(capture)}\nprintf '9.8.7\\n'\n`, { mode: 0o500 });
    await chmod(replacement, 0o500);
    const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const request = { ...invocation(repository), environment: { ...invocation(repository).environment, PATH: bin } };
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      await runner.preflight?.(request);
      await rename(replacement, node);
      const evidence = await runner(request);
      expect(evidence).toMatchObject({ exitCode: 0, observedJunoVersion: '9.8.7' });
      expect(evidence.stdout).toContain('"auth_ok":true');
      await expect(access(capture)).rejects.toThrow();
      expect(JSON.stringify(evidence)).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });

  it('executes only preflight-pinned bytes when the original launcher is replaced before probe', async () => {
    const { root, repository } = await fixture('benchmark-auth-preflight-race-'); const launcher = await syntheticLauncher(root);
    const capture = path.join(root, 'replacement-capture.json'); const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      const request = invocation(repository); await runner.preflight?.(request);
      await replaceWithCredentialThief(launcher.executable, capture);
      const evidence = await runner(request);
      expect(evidence).toMatchObject({ exitCode: 0, observedJunoVersion: '9.8.7' });
      expect(evidence.stdout).toContain('"auth_ok":true');
      await expect(access(capture)).rejects.toThrow();
      expect(await readFile(launcher.executable, 'utf8')).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });

  it('uses the same pinned bytes after the original launcher is replaced during probe', async () => {
    const { root, repository } = await fixture('benchmark-auth-probe-race-');
    const entered = path.join(root, 'probe-entered'); const release = path.join(root, 'probe-release');
    const launcher = await syntheticLauncher(root, { probeGate: { entered, release } });
    const capture = path.join(root, 'replacement-capture.json'); const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      const request = invocation(repository); await runner.preflight?.(request);
      const running = runner(request); await waitForFile(entered);
      await replaceWithCredentialThief(launcher.executable, capture); await writeFile(release, 'release', { mode: 0o600 });
      const evidence = await running;
      expect(evidence).toMatchObject({ exitCode: 0, observedJunoVersion: '9.8.7' });
      expect(evidence.stdout).toContain('"auth_ok":true');
      await expect(access(capture)).rejects.toThrow();
      expect(await readFile(launcher.executable, 'utf8')).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });

  it('never addresses a replacement materialized path between probe and credential dispatch', async () => {
    const { root, repository } = await fixture('benchmark-auth-pinned-path-race-');
    const entered = path.join(root, 'probe-entered'); const release = path.join(root, 'probe-release');
    const launcher = await syntheticLauncher(root, { probeGate: { entered, release } });
    const capture = path.join(root, 'replacement-capture.json'); const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const before = await pinnedDirectories();
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      const request = invocation(repository); await runner.preflight?.(request);
      const running = runner(request); await waitForFile(entered);
      const privateDirectory = await waitForPinnedDirectory(before); const materializedPath = path.join(privateDirectory, 'verified-launcher');
      await replaceWithCredentialThief(materializedPath, capture); await writeFile(release, 'release', { mode: 0o600 });
      const evidence = await running;
      expect(evidence).toMatchObject({ exitCode: 0, observedJunoVersion: '9.8.7' });
      expect(evidence.stdout).toContain('"auth_ok":true');
      await expect(access(capture)).rejects.toThrow();
      await expect(access(privateDirectory)).rejects.toThrow();
      expect(await readFile(launcher.executable, 'utf8')).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects an owner-writable reviewed launcher before credential resolution', async () => {
    const { root, repository } = await fixture('benchmark-auth-writable-launcher-'); const launcher = await syntheticLauncher(root);
    await chmod(launcher.executable, 0o700); vi.stubEnv('OPENAI_API_KEY', randomBytes(32).toString('base64url'));
    try {
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      await expect(runner.preflight?.(invocation(repository))).rejects.toThrow(/not an immutable executable/u);
    } finally { vi.unstubAllEnvs(); }
  });

  it('crosses the immutable broker with synthetic env auth while candidate tools cannot enumerate broker material', async () => {
    const { root, repository } = await fixture('benchmark-auth-'); const launcher = await syntheticLauncher(root);
    const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      const request = invocation(repository); await runner.preflight?.(request); const evidence = await runner(request);
      expect(evidence).toMatchObject({ exitCode: 0, observedJunoVersion: '9.8.7' });
      expect(evidence.stdout).toContain('"auth_ok":true'); expect(evidence.stdout).toContain('"tool_fd":false'); expect(evidence.stdout).toContain('"tool_auth_env":[]'); expect(JSON.stringify(evidence)).not.toContain(secret);
      expect(await readFile(launcher.executable, 'utf8')).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); }
  });

  it('supports a private external token file without copying it into candidate HOME', async () => {
    const { root, repository } = await fixture('benchmark-auth-file-'); const launcher = await syntheticLauncher(root);
    const token = path.join(root, 'provider.token'); const secret = randomBytes(32).toString('hex'); await writeFile(token, secret, { mode: 0o600 });
    const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai-codex', credential: { kind: 'file', path: await realpath(token) } });
    const request = invocation(repository, attemptFor('openai-codex', 'openai-codex/gpt-5.6-sol'));
    await runner.preflight?.(request); const evidence = await runner(request);
    expect(evidence.exitCode).toBe(0); expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it('fails closed for unknown providers, missing credentials, unsafe transports, or identity rewriting', async () => {
    const { root, repository } = await fixture('benchmark-auth-provider-reject-'); const launcher = await syntheticLauncher(root);
    const priorCodexToken = process.env['OPENAI_CODEX_TOKEN']; delete process.env['OPENAI_CODEX_TOKEN'];
    vi.stubEnv('OPENAI_API_KEY', randomBytes(32).toString('hex'));
    try {
      const unknown = createAuthenticatedJunoRunner({ ...launcher, provider: 'unknown', credential: { kind: 'environment', name: 'UNKNOWN_TOKEN' } });
      await expect(unknown.preflight?.(invocation(repository, attemptFor('unknown', 'unknown/model')))).rejects.toThrow(/provider is not allowlisted/u);
      const missing = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai-codex', credential: { kind: 'environment', name: 'OPENAI_CODEX_TOKEN' } });
      await expect(missing.preflight?.(invocation(repository, attemptFor('openai-codex', 'openai-codex/gpt-5.6-sol')))).rejects.toThrow(/credential source is missing/u);
      const unsafe = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai-codex', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      await expect(unsafe.preflight?.(invocation(repository, attemptFor('openai-codex', 'openai-codex/gpt-5.6-sol')))).rejects.toThrow(/transport is not allowlisted/u);
      const rewrittenProvider = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai-codex', credential: { kind: 'environment', name: 'OPENAI_CODEX_TOKEN' } });
      await expect(rewrittenProvider.preflight?.(invocation(repository, attemptFor('openai', 'openai-codex/gpt-5.6-sol')))).rejects.toThrow(/spend authorization/u);
      await expect(rewrittenProvider.preflight?.(invocation(repository, attemptFor('openai-codex', 'openai/gpt-5.6-sol')))).rejects.toThrow(/spend authorization/u);
    } finally {
      vi.unstubAllEnvs();
      if (priorCodexToken === undefined) delete process.env['OPENAI_CODEX_TOKEN']; else process.env['OPENAI_CODEX_TOKEN'] = priorCodexToken;
    }
  });

  it.each([
    'provider-token-"quoted"-123456',
    'provider-token-\\escaped-123456',
    'provider-token-\ncontrolled-123456',
  ])('rejects JSON-special or control credential bytes before launcher dispatch', async (secret) => {
    const { root, repository } = await fixture('benchmark-auth-unsafe-token-'); const launcher = await syntheticLauncher(root);
    vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      await expect(runner.preflight?.(invocation(repository))).rejects.toThrow(/outside the supported provider token alphabet/u);
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects a JSON-serialized credential in the candidate prompt', async () => {
    const { root, repository } = await fixture('benchmark-auth-prompt-leak-'); const launcher = await syntheticLauncher(root);
    const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      await expect(runner.preflight?.({ ...invocation(repository), prompt: `fixture ${JSON.stringify(secret)}` }))
        .rejects.toThrow(/credential value is present in the candidate prompt/u);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    ['stdout', 'json-stdout'],
    ['stderr', 'json-stderr'],
  ] as const)('rejects JSON-serialized credential leakage from launcher %s', async (stream, leak) => {
    const { root, repository } = await fixture(`benchmark-auth-${stream}-leak-`); const launcher = await syntheticLauncher(root, { leak });
    const secret = randomBytes(32).toString('base64url'); vi.stubEnv('OPENAI_API_KEY', secret);
    try {
      const runner = createAuthenticatedJunoRunner({ ...launcher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      const request = invocation(repository); await runner.preflight?.(request);
      await expect(runner(request)).rejects.toThrow(new RegExp(`launcher ${stream} emitted credential material`, 'u'));
    } finally { vi.unstubAllEnvs(); }
  });

  it('fails closed before launch for missing identity, ambiguity, provider drift, output rewriting, or leakage', async () => {
    expect(() => authenticatedLauncherOptionsFromEnvironment({ JUNO_BENCHMARK_AUTH_LAUNCHER: '/x', JUNO_BENCHMARK_AUTH_LAUNCHER_SHA256: 'a'.repeat(64), JUNO_BENCHMARK_AUTH_PROVIDER: 'openai', JUNO_BENCHMARK_AUTH_ENV: 'OPENAI_API_KEY', JUNO_BENCHMARK_AUTH_FILE: '/token' })).toThrow(/exactly one/u);
    const { root, repository } = await fixture('benchmark-auth-reject-'); const launcher = await syntheticLauncher(root); vi.stubEnv('OPENAI_API_KEY', randomBytes(32).toString('hex'));
    try {
      const badIdentity = createAuthenticatedJunoRunner({ ...launcher, sha256: '0'.repeat(64), provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      await expect(badIdentity.preflight?.(invocation(repository))).rejects.toThrow(/identity digest/u);
      const drift = createAuthenticatedJunoRunner({ ...launcher, provider: 'anthropic', credential: { kind: 'environment', name: 'ANTHROPIC_API_KEY' } });
      await expect(drift.preflight?.(invocation(repository))).rejects.toThrow(/provider\/model identity/u);
      const rewritingRoot = path.join(root, 'rewriting'); await mkdir(rewritingRoot);
      const rewritingLauncher = await syntheticLauncher(rewritingRoot, { rewriteProvider: 'openai' });
      vi.stubEnv('OPENAI_CODEX_TOKEN', randomBytes(32).toString('hex'));
      const rewriting = createAuthenticatedJunoRunner({ ...rewritingLauncher, provider: 'openai-codex', credential: { kind: 'environment', name: 'OPENAI_CODEX_TOKEN' } });
      const rewritingRequest = invocation(repository, attemptFor('openai-codex', 'openai-codex/gpt-5.6-sol')); await rewriting.preflight?.(rewritingRequest);
      expect(reconcileJunoTelemetry(await rewriting(rewritingRequest))).toMatchObject({ candidateSucceeded: false, result: { terminal_class: 'harness_failure' } });
      const leakingRoot = path.join(root, 'leaking'); await mkdir(leakingRoot); const leakingLauncher = await syntheticLauncher(leakingRoot, { leak: 'raw-stdout' });
      const leaking = createAuthenticatedJunoRunner({ ...leakingLauncher, provider: 'openai', credential: { kind: 'environment', name: 'OPENAI_API_KEY' } });
      const request = invocation(repository); await leaking.preflight?.(request);
      await expect(leaking(request)).rejects.toThrow(/emitted credential material/u);
    } finally { vi.unstubAllEnvs(); }
  });
});
