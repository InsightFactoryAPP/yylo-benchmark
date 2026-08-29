#!/usr/bin/env node
// YYLO Benchmark reviewed workflow boundary
//
// Protocol: juno_benchmark_workflow_process_boundary.v1
//
// This module is the hash-pinned, project-installable credential boundary for
// live YYLO Benchmark workflow execution. The benchmark runtime spawns it as
//
//   node --input-type=module - <operation> --protocol <protocol>
//
// with the exact module bytes on stdin and one JSON request document on file
// descriptor 3. It answers with exactly one JSON document on stdout and a
// canonical exit code. It never writes credentials, credential values, or its
// own stderr to stdout, receipts, journals, or transcripts.
//
// Operations:
//   probe      -> { schema_version, providers: string[] }
//   preflight  -> { ok, provider, model, juno_version }
//   dispatch   -> terminal result (see terminalResult in the runtime)
//   reconcile  -> { state: 'terminal' | 'safely_resumable' | 'proven_not_dispatched' | 'ambiguous' }
//   resume     -> terminal result
//   judge      -> { resolved: boolean, evidence: string }
//
// Model-dispatch transport: the boundary owns exactly one --execution-envelope
// request flag (root/global position) and the canonical Juno child correlation
// environment. A dispatched child that terminates with a known status but no
// valid juno_execution_envelope.v1 yields a retained redacted harness-failure
// terminal; only overflow or timeout before child settlement stays ambiguous.
//
// Credential ownership: provider credentials stay in this process's
// environment (or, for OAuth providers, in the read-only Pi agent auth store
// the dispatched child itself reads) and are routed only to the exact
// requested child argv. The benchmark planner, plans, receipts, and reports
// only ever see provider names, never credential material.
//
// Durable ambiguity-safe recovery: before any consequential child spawn the
// boundary writes a private dispatch journal intent bound to the exact
// dispatch identity; after the child closes it appends the terminal result.
// reconcile reads that journal and reports exact truth:
//   - no intent                     -> proven_not_dispatched
//   - intent + terminal             -> terminal
//   - intent only, live model step  -> ambiguous (paid external effect possible)
//   - intent only, otherwise        -> safely_resumable
//
// Synthetic transport: setting YYLO_BENCHMARK_BOUNDARY_SYNTHETIC=1 answers
// model dispatch and judge operations deterministically without spawning any
// provider child, for installed-public-CLI acceptance and release tests.
// Synthetic terminals and run identities are explicitly labeled. The only
// child process synthetic mode may spawn is the read-only `yy --version`
// identity probe.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PROTOCOL = 'juno_benchmark_workflow_process_boundary.v1';
const ENVELOPE_SCHEMA = 'juno_execution_envelope.v1';
// The benchmark owns the machine-output transport request: workflow YAML is
// product-owned and never carries benchmark transport flags, while the
// executed argv carries exactly one flag in the root/global position Juno
// parses (options after the `pi` alias command are silently dropped by
// Commander's allowUnknownOption passthrough).
const ENVELOPE_FLAG = '--execution-envelope';
// Canonical Juno child correlation contract (juno-code invocation lifecycle):
// an explicit child marks its benchmark workflow run/step and launch surface
// so the invocation is directly discoverable in telemetry without time-window
// inference. Values must satisfy Juno's bounded correlation token shape.
const CHILD_CORRELATION_LAUNCH_SURFACE = 'yylo-benchmark';
const CHILD_CORRELATION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const JOURNAL_INTENT_SCHEMA = 'juno_benchmark_boundary_dispatch_intent.v1';
const JOURNAL_TERMINAL_SCHEMA = 'juno_benchmark_boundary_dispatch_terminal.v1';
const OPERATIONS = new Set(['probe', 'preflight', 'dispatch', 'reconcile', 'resume', 'judge']);
const PROVIDER_CREDENTIALS = Object.freeze({
  'openai-codex': 'OPENAI_CODEX_TOKEN',
  zai: 'ZAI_API_KEY',
});
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const SAFE_CREDENTIAL_TOKEN = /^[A-Za-z0-9._~-]+$/u;
// The dispatched `yy pi` child authenticates OAuth providers from the Pi
// agent auth store (populated by `yy auth import-codex` from the Codex native
// store). A valid unexpired entry there is authoritative credential proof:
// preflight must not demand a second copy of an existing credential in the
// boundary environment. The override exists only for module tests and
// harnesses; it is owner-controlled and never workflow-controlled.
const PI_AUTH_STORE_MAX_BYTES = 256 * 1024;
const CREDENTIAL_EXPIRY_SKEW_MS = 60_000;
const PI_AUTH_STORE_PROVIDERS = new Set(['openai-codex']);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 1_000;

function fail(message) {
  // Boundary stderr and error documents never carry credential material:
  // messages are static or identity-shaped only. The structured stdout
  // document lets the runtime surface an actionable reason while the free-form
  // stderr stays private to the spawning process.
  process.stderr.write(`workflow-boundary: ${message}\n`);
  try { process.stdout.write(JSON.stringify({ schema_version: 'juno_benchmark_boundary_error.v1', message: message.slice(0, 512) })); } catch { /* stdout closed */ }
  process.exit(1);
}

const argument = process.argv[2] ?? '';
if (!OPERATIONS.has(argument)) fail(`unsupported operation ${argument || '<missing>'}`);
if (process.argv[3] !== '--protocol' || process.argv[4] !== PROTOCOL) fail('protocol selection is invalid');
const operation = argument;

let request;
try {
  const raw = readFileSync(3, 'utf8');
  request = JSON.parse(raw);
} catch {
  fail('request document on descriptor 3 is missing or malformed');
}
if (request === null || typeof request !== 'object' || Array.isArray(request)) fail('request document must be an object');

const environment = process.env;
const synthetic = environment.YYLO_BENCHMARK_BOUNDARY_SYNTHETIC === '1';
const junoExecutable = (environment.YYLO_BENCHMARK_JUNO_EXECUTABLE ?? '').trim() || 'yy';
const registryRoot = (environment.YYLO_BENCHMARK_REGISTRY ?? '').trim()
  || path.join(process.cwd(), '.juno_task', 'artifacts', 'yylo-benchmark');
const stateRoot = (environment.YYLO_BENCHMARK_BOUNDARY_STATE_ROOT ?? '').trim()
  || path.join(registryRoot, 'boundary-state');

const isHash = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

// Owner-controlled project root binding: the benchmark CLI spawns the boundary
// from the consumer project, so the inherited working directory is the exact
// workflow working directory. The explicit override exists for harnesses that
// must pin it; it is never workflow-controlled.
const projectRoot = (() => {
  const declared = (environment.YYLO_BENCHMARK_BOUNDARY_PROJECT_ROOT ?? '').trim();
  return declared === '' ? process.cwd() : declared;
})();

function sha256Hex(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function invocationOf(request) {
  const invocation = request.invocation;
  if (invocation === null || typeof invocation !== 'object' || Array.isArray(invocation)) fail('invocation is missing');
  return invocation;
}

// ---------------------------------------------------------------------------
// Minimal strict YAML-subset reader for compiled workflow bytes.
//
// Compiled workflow bytes are always produced by the benchmark planner's
// canonical `yaml.stringify(semantics, { lineWidth: 0, sortMapEntries: false })`
// overlay, which emits exactly: block mappings, block sequences, plain
// scalars, double-quoted (JSON escape) scalars, single-quoted scalars, and
// block literal (`|` family) scalars. Anything else fails closed. Only the
// `vars` plus `steps[].id` and `steps[].command` are extracted; other fields are
// structurally skipped without interpretation.
// ---------------------------------------------------------------------------

function parseScalarFromToken(token) {
  if (token.startsWith('"')) {
    if (!token.endsWith('"') || token.length < 2) throw new Error('malformed double-quoted scalar');
    try { return JSON.parse(token); } catch { throw new Error('malformed double-quoted scalar escape'); }
  }
  if (token.startsWith("'")) {
    if (!token.endsWith("'") || token.length < 2) throw new Error('malformed single-quoted scalar');
    return token.slice(1, -1).replace(/''/gu, "'");
  }
  if (token.startsWith('[') || token.startsWith('{')) throw new Error('flow collections are not part of the compiled workflow form');
  if (token.includes('\t')) throw new Error('workflow bytes contain a tab outside a block scalar');
  return token;
}

function parseWorkflowSteps(text) {
  // Blank lines are structurally insignificant but are retained verbatim
  // because literal block scalars own them as content: the canonical planner
  // emits multiline prompt scalars whose blank lines, deeper indentation, and
  // explicit indentation indicators must round-trip exactly.
  const lines = [];
  const rawLines = text.split(/\r?\n/u);
  // A document's final line terminator is not an extra empty line; dropping
  // exactly one trailing split artifact keeps `|+` chomping byte-exact.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  for (const rawLine of rawLines) {
    const blank = rawLine.trim() === '';
    const indent = /^ */u.exec(rawLine)?.[0].length ?? 0;
    const tabIndent = !blank && rawLine[indent] === '\t';
    lines.push({ indent, raw: rawLine, content: blank ? '' : rawLine.trim(), blank, tabIndent });
  }
  let position = 0;

  const skipBlanks = () => {
    while (position < lines.length && lines[position].blank) position += 1;
    // Blank lines are legal block-scalar content, but a structural line must
    // never begin with a tab; this check runs only on structural paths.
    if (position < lines.length && lines[position].tabIndent) throw new Error('workflow bytes contain a tab indent');
  };

  const splitKey = (content) => {
    const separator = content.indexOf(':');
    if (separator <= 0) throw new Error('workflow mapping entry is malformed');
    const key = content.slice(0, separator);
    if (/["'[{]/u.test(key)) throw new Error('workflow mapping keys must be plain');
    const rest = content.slice(separator + 1);
    return { key, rest: rest.trim() === '' ? null : rest.trim() };
  };

  // Block scalar headers the canonical `yaml` emitter produces: `|`, `|-`,
  // `|+`, plus an optional explicit indentation indicator in either order
  // (`|2-`, `|-2`) used when the first content line begins with a space.
  function blockScalarHeader(header) {
    const rest = header.slice(1);
    if (!/^(?:[1-9](?:[-+])?|[-+]?[1-9]?)$/u.test(rest)) throw new Error(`unsupported block scalar header: ${header}`);
    const chomp = rest.includes('-') ? 'strip' : rest.includes('+') ? 'keep' : 'clip';
    const indicator = /[1-9]/u.exec(rest)?.[0];
    return { chomp, indicator: indicator === undefined ? null : Number(indicator) };
  }
  const isBlockScalarHeader = (token) => token.startsWith('|');

  function readBlockScalar(header, lineIndent) {
    if (!isBlockScalarHeader(header)) throw new Error(`unsupported block scalar header: ${header}`);
    const { chomp, indicator } = blockScalarHeader(header);
    const collected = [];
    let blockIndent = indicator === null ? null : lineIndent + indicator;
    while (position < lines.length) {
      const line = lines[position];
      // A blank line is owned by the open scalar (it survives as content or is
      // consumed by chomping); only a non-blank dedent closes the scalar.
      if (line.blank) {
        collected.push(blockIndent === null || line.raw.length < blockIndent ? '' : line.raw.slice(blockIndent));
        position += 1;
        continue;
      }
      if (line.indent <= lineIndent) break;
      if (blockIndent === null) blockIndent = line.indent;
      if (line.indent < blockIndent) break;
      collected.push(line.raw.slice(blockIndent));
      position += 1;
    }
    if (blockIndent === null) throw new Error('block scalar has no content');
    let value = collected.map((lineText) => `${lineText}\n`).join('');
    if (chomp === 'strip') value = value.replace(/\n+$/u, '');
    else if (chomp === 'clip') value = value.replace(/\n+$/u, '\n');
    return value;
  }

  function readSequence(indent) {
    const items = [];
    while (position < lines.length) {
      skipBlanks();
      if (position >= lines.length) break;
      const line = lines[position];
      if (line.indent !== indent || !(line.content === '-' || line.content.startsWith('- '))) {
        if (line.indent >= indent) throw new Error('workflow sequence indentation is inconsistent');
        break;
      }
      const rest = line.content === '-' ? '' : line.content.slice(2).trim();
      position += 1;
      if (rest === '') {
        skipBlanks();
        if (position >= lines.length || lines[position].indent <= indent) throw new Error('workflow sequence item is empty');
        items.push(readNode(lines[position].indent));
      } else if (/^[^:]+:/u.test(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
        // Mapping whose first entry shares the dash line.
        const entryIndent = indent + 2;
        items.push(readMapping(entryIndent, [rest]));
      } else if (isBlockScalarHeader(rest)) {
        items.push(readBlockScalar(rest, indent));
      } else {
        items.push(parseScalarFromToken(rest));
      }
    }
    return items;
  }

  function readMapping(indent, carried) {
    const entries = new Map();
    const consume = (content) => {
      const { key, rest } = splitKey(content);
      if (entries.has(key)) throw new Error('workflow mapping has duplicate keys');
      if (rest === null) {
        const saved = position;
        skipBlanks();
        const next = lines[position];
        position = saved;
        if (next === undefined) throw new Error('workflow mapping value is missing');
        if (next.indent === indent && (next.content === '-' || next.content.startsWith('- '))) {
          entries.set(key, readSequence(indent));
        } else if (next.indent > indent) {
          entries.set(key, readNode(next.indent));
        } else {
          entries.set(key, null);
        }
      } else if (isBlockScalarHeader(rest)) {
        entries.set(key, readBlockScalar(rest, indent));
      } else {
        entries.set(key, parseScalarFromToken(rest));
      }
    };
    for (const content of carried) consume(content);
    while (position < lines.length) {
      skipBlanks();
      if (position >= lines.length) break;
      const line = lines[position];
      if (line.indent !== indent) {
        if (line.indent > indent) throw new Error('workflow mapping indentation is inconsistent');
        break;
      }
      if (line.content.startsWith('- ') || line.content === '-') throw new Error('unexpected sequence entry in mapping position');
      position += 1;
      consume(line.content);
    }
    return entries;
  }

  function readNode(indent) {
    skipBlanks();
    const line = lines[position];
    if (line === undefined) throw new Error('workflow node is missing');
    if (line.content === '-' || line.content.startsWith('- ')) return readSequence(indent);
    return readMapping(indent, []);
  }

  skipBlanks();
  if (position >= lines.length || lines[position].indent !== 0) throw new Error('workflow document must start at column zero');
  const document = readNode(0);
  skipBlanks();
  if (position !== lines.length) throw new Error('workflow document has trailing unconsumed content');
  const steps = document instanceof Map ? document.get('steps') : undefined;
  if (!Array.isArray(steps)) throw new Error('workflow document has no steps sequence');
  const extracted = [];
  for (const step of steps) {
    if (!(step instanceof Map)) throw new Error('workflow step must be a mapping');
    const id = step.get('id');
    const command = step.get('command');
    if (typeof id !== 'string' || id.trim() === '') throw new Error('workflow step id must be a non-empty string');
    if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === 'string' && item !== '')) {
      throw new Error(`workflow step ${id} command must be a non-empty explicit argument array`);
    }
    extracted.push({ id, command: [...command] });
  }
  const declared = document instanceof Map ? (document.get('vars') ?? document.get('variables')) : undefined;
  if (declared !== undefined && !(declared instanceof Map)) throw new Error('workflow vars must be a mapping');
  return { steps: extracted, vars: declared ?? new Map() };
}

function compiledStepFor(invocation, runtimeVariables = {}, allowStepReferences = false) {
  if (typeof invocation.workflow_bytes_base64 !== 'string' || invocation.workflow_bytes_base64 === '') fail('invocation has no compiled workflow bytes');
  if (!isHash(invocation.workflow_sha256)) fail('invocation workflow hash is invalid');
  const bytes = Buffer.from(invocation.workflow_bytes_base64, 'base64');
  if (bytes.toString('base64') !== invocation.workflow_bytes_base64 || `sha256:${sha256Hex(bytes)}` !== invocation.workflow_sha256) {
    fail('compiled workflow bytes do not match their exact invocation identity');
  }
  let parsed;
  try { parsed = parseWorkflowSteps(bytes.toString('utf8')); }
  catch (error) { fail(`compiled workflow bytes cannot be parsed: ${error instanceof Error ? error.message : String(error)}`); }
  const step = parsed.steps.find((item) => item.id === invocation.step_id);
  if (step === undefined) fail(`compiled workflow does not contain exact step ${invocation.step_id}`);
  const variables = invocation.variables;
  if (variables !== undefined && (variables === null || typeof variables !== 'object' || Array.isArray(variables))) fail('invocation variables are invalid');
  if (runtimeVariables === null || typeof runtimeVariables !== 'object' || Array.isArray(runtimeVariables)) fail('runtime workflow variables are invalid');
  const resolvedVariables = {
    repo_root: projectRoot,
    run_id: `yylo-benchmark-${String(invocation.plan_id).replace(/^sha256:/u, '').slice(0, 16)}`,
    ...Object.fromEntries(parsed.vars),
    ...variables,
    ...runtimeVariables,
  };
  const resolving = new Set();
  const resolveName = (rawName) => {
    const name = rawName.startsWith('vars.') ? rawName.slice(5) : rawName;
    const value = resolvedVariables[name];
    if (value === undefined || value === null) {
      if (allowStepReferences && /^steps\.[A-Za-z0-9_.-]+\.response$/u.test(rawName)) return `{{ ${rawName} }}`;
      fail(`workflow variable ${rawName} is not bound for this invocation`);
    }
    if (typeof value !== 'string') return String(value);
    if (resolving.has(name)) fail(`workflow variable ${rawName} is recursively defined`);
    resolving.add(name);
    const output = substitute(value);
    resolving.delete(name);
    return output;
  };
  const substitute = (text) => {
    const resolved = text
      .replace(/\$\(([A-Za-z0-9_.-]+)\)/gu, (_whole, name) => resolveName(name))
      .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (_whole, name) => resolveName(name));
    if (!allowStepReferences && (resolved.includes('$(') || /\{\{[^}]*\}\}/u.test(resolved))) fail('workflow command contains an unresolved variable reference');
    return resolved;
  };
  return { id: step.id, command: step.command.map(substitute), deterministic: invocation.deterministic_command ?? null };
}

// ---------------------------------------------------------------------------
// YYLO executable identity probe (read-only).
// ---------------------------------------------------------------------------

function probeJunoVersion() {
  const env = { ...environment };
  delete env.YYLO_BENCHMARK_WORKFLOW_BOUNDARY;
  delete env.YYLO_BENCHMARK_WORKFLOW_BOUNDARY_SHA256;
  const result = spawnSync(junoExecutable, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024, env });
  if (result.error || result.status !== 0 || result.signal !== null) fail(`YYLO identity probe failed (${result.error?.message ?? result.status ?? result.signal ?? 'unknown'})`);
  const output = (result.stdout ?? '').trim();
  const match = /^(?:(?:yylo|juno-code)\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(output);
  if (match?.[1] === undefined) fail('YYLO identity probe returned an invalid version');
  return match[1];
}

function piAgentAuthStorePath() {
  const declared = (environment.YYLO_BENCHMARK_BOUNDARY_PI_AUTH_PATH ?? '').trim();
  if (declared !== '') return declared;
  return path.join(homedir(), '.pi', 'agent', 'auth.json');
}

// Read-only probe of the exact credential store the dispatched `yy pi` child
// will read. Never returns or logs credential material; only route identity.
function validPiAgentAuthCredential(provider) {
  const storePath = piAgentAuthStorePath();
  let bytes;
  try { bytes = readFileSync(storePath); }
  catch { fail(`provider ${provider} credential is unavailable: set the boundary environment credential or refresh the Pi agent auth store with yy auth import-codex`); }
  if (bytes.length === 0 || bytes.length > PI_AUTH_STORE_MAX_BYTES) fail('Pi agent auth store is empty or oversized');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('Pi agent auth store is malformed'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Pi agent auth store is malformed');
  const entry = parsed[provider];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`Pi agent auth store has no ${provider} credential; refresh it with yy auth import-codex`);
  }
  if (entry.type !== 'oauth' || typeof entry.access !== 'string' || entry.access === ''
      || typeof entry.refresh !== 'string' || entry.refresh === '') {
    fail(`Pi agent auth store ${provider} credential is not a complete OAuth entry; refresh it with yy auth import-codex`);
  }
  const expires = entry.expires;
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= Date.now() + CREDENTIAL_EXPIRY_SKEW_MS) {
    fail(`Pi agent auth store ${provider} credential is missing or expired; refresh it with yy auth import-codex`);
  }
  return true;
}

function credentialFor(provider) {
  const name = PROVIDER_CREDENTIALS[provider];
  if (name === undefined) fail(`provider ${provider} has no credential route`);
  if (synthetic) return null;
  const value = environment[name];
  if (value !== undefined && value !== '') {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes === 0 || bytes > MAX_CREDENTIAL_BYTES || !SAFE_CREDENTIAL_TOKEN.test(value)) fail(`provider ${provider} credential ${name} is missing, oversized, or malformed`);
    return name;
  }
  if (PI_AUTH_STORE_PROVIDERS.has(provider)) {
    const storePath = piAgentAuthStorePath();
    if (existsSync(storePath)) {
      validPiAgentAuthCredential(provider);
      return 'pi-agent-auth-store';
    }
    fail(`provider ${provider} requires ${name} to be set in the boundary environment or a valid unexpired ${provider} credential in the Pi agent auth store`);
  }
  fail(`provider ${provider} requires ${name} to be set in the boundary environment`);
}

// ---------------------------------------------------------------------------
// Durable dispatch journal.
// ---------------------------------------------------------------------------

function journalPaths(dispatchId) {
  const hex = dispatchId.replace(/^sha256:/u, '');
  return {
    intent: path.join(stateRoot, `dispatch-${hex}.intent.json`),
    terminal: path.join(stateRoot, `dispatch-${hex}.terminal.json`),
  };
}

function writePrivate(destination, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = openSync(temporary, 'w', 0o600);
  try { writeSync(handle, serialized); fsyncSync(handle); } finally { closeSync(handle); }
  try { renameSync(temporary, destination); } catch (error) { unlinkSync(temporary); throw error; }
}

function ensureStateRoot() {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const metadata = statSync(stateRoot);
  if (!metadata.isDirectory()) fail('boundary state root is not a directory');
}

function readJsonFile(destination, schema) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(destination, 'utf8')); }
  catch { fail(`boundary journal document is missing or malformed: ${path.basename(destination)}`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema_version !== schema) {
    fail(`boundary journal document schema is invalid: ${path.basename(destination)}`);
  }
  return parsed;
}

function recordIntent(invocation) {
  ensureStateRoot();
  const paths = journalPaths(invocation.dispatch_id);
  if (existsSync(paths.terminal)) return 'terminal';
  if (existsSync(paths.intent)) return 'intent';
  const serialized = `${JSON.stringify({
    schema_version: JOURNAL_INTENT_SCHEMA, dispatch_id: invocation.dispatch_id, invocation_hash: invocation.invocation_hash,
    plan_id: invocation.plan_id, step_id: invocation.step_id, model: invocation.model, provider: invocation.provider,
    transport: synthetic ? 'synthetic' : 'live', started_at: new Date().toISOString(),
  })}\n`;
  const temporary = `${paths.intent}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = openSync(temporary, 'w', 0o600);
  try { writeSync(handle, serialized); fsyncSync(handle); } finally { closeSync(handle); }
  try {
    try { linkSync(temporary, paths.intent); return 'started'; } catch (error) {
      if ((error).code !== 'EEXIST') throw error;
      return 'intent';
    }
  } finally { try { unlinkSync(temporary); } catch { /* consumed by the exclusive link */ } }
}

function readIntent(invocation) {
  const paths = journalPaths(invocation.dispatch_id);
  if (!existsSync(paths.intent)) return null;
  const intent = readJsonFile(paths.intent, JOURNAL_INTENT_SCHEMA);
  if (intent.dispatch_id !== invocation.dispatch_id || intent.invocation_hash !== invocation.invocation_hash
      || intent.step_id !== invocation.step_id || intent.model !== invocation.model || intent.provider !== invocation.provider) {
    fail('boundary journal intent does not bind the exact requested dispatch identity');
  }
  return intent;
}

function readTerminal(invocation) {
  const paths = journalPaths(invocation.dispatch_id);
  if (!existsSync(paths.terminal)) return null;
  const document = readJsonFile(paths.terminal, JOURNAL_TERMINAL_SCHEMA);
  if (document.dispatch_id !== invocation.dispatch_id || document.invocation_hash !== invocation.invocation_hash) {
    fail('boundary journal terminal does not bind the exact requested dispatch identity');
  }
  const result = document.result;
  if (result === null || typeof result !== 'object' || result.dispatch_id !== invocation.dispatch_id) fail('boundary journal terminal result is invalid');
  return result;
}

function recordTerminal(invocation, result) {
  ensureStateRoot();
  writePrivate(journalPaths(invocation.dispatch_id).terminal, {
    schema_version: JOURNAL_TERMINAL_SCHEMA, dispatch_id: invocation.dispatch_id, invocation_hash: invocation.invocation_hash,
    recorded_at: new Date().toISOString(), result,
  });
}

// ---------------------------------------------------------------------------
// Child execution.
// ---------------------------------------------------------------------------

function runChild(argv, { timeoutMs, extraEnvironment = {}, captureEvidence = false }) {
  const evidenceFd = 3;
  const child = spawn(argv[0], argv.slice(1), { cwd: projectRoot,
    env: { ...environment, ...extraEnvironment, ...(captureEvidence ? { YYLO_EXECUTION_EVIDENCE_FD: String(evidenceFd) } : {}) },
    stdio: captureEvidence ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], shell: false });
  const stdout = []; const stderr = []; const evidence = []; let captured = 0; let overflow = false;
  const collect = (target) => (chunk) => {
    captured += chunk.length;
    if (captured > MAX_CAPTURE_BYTES) { overflow = true; child.kill('SIGKILL'); } else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  if (captureEvidence) child.stdio[evidenceFd].on('data', collect(evidence));
  let timedOut = false; let force = undefined;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS); }, timeoutMs);
  const closed = awaitClose(child).finally(() => { clearTimeout(timeout); if (force !== undefined) clearTimeout(force); });
  return closed.then((outcome) => ({ outcome, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
    evidence: Buffer.concat(evidence), overflow, timedOut }));
}

function awaitClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function finalStructuredObject(text) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* an ordinary progress line */ }
  }
  return null;
}

function envelopeOf(stdout) {
  const envelope = finalStructuredObject(stdout.toString('utf8'));
  if (envelope === null || envelope.schema_version !== ENVELOPE_SCHEMA) return null;
  return envelope;
}

function resolveExecutable(name) {
  if (name === 'yy') return junoExecutable;
  return name;
}

function boundedTranscript(stdout, stderr) {
  const parts = [];
  const out = stdout.toString('utf8');
  parts.push(out.length > MAX_TRANSCRIPT_BYTES ? `${out.slice(0, MAX_TRANSCRIPT_BYTES)}\n[truncated]` : out);
  if (stderr.length > 0) {
    const err = stderr.toString('utf8');
    parts.push(`\n[stderr]\n${err.length > MAX_TRANSCRIPT_BYTES ? `${err.slice(0, MAX_TRANSCRIPT_BYTES)}\n[truncated]` : err}`);
  }
  return parts.join('');
}

function childCorrelationEnvironment(invocation) {
  // Bind the dispatched child to the benchmark's canonical workflow
  // run/step identity. Invalid correlation tokens are skipped rather than
  // weakening the child contract Juno validates independently.
  const values = [
    ['YYLO_INVOCATION_CHILD', '1'],
    ['YYLO_WORKFLOW_RUN_ID', invocation.plan_id],
    ['YYLO_WORKFLOW_STEP_ID', invocation.step_id],
    ['YYLO_LAUNCH_SURFACE', CHILD_CORRELATION_LAUNCH_SURFACE],
  ];
  return Object.fromEntries(values.filter(([, value]) => typeof value === 'string' && CHILD_CORRELATION_TOKEN.test(value)));
}

function validatedStepFor(invocation, runtimeVariables = {}, allowStepReferences = false) {
  // Every no-spawn validation of the exact compiled workflow, its resolved
  // argument array, and the deterministic policy prefix happens here, before
  // any durable dispatch intent exists: a rejected request must remain
  // provably not dispatched and recoverable without deleting evidence.
  const step = compiledStepFor(invocation, runtimeVariables, allowStepReferences);
  const deterministicPolicy = step.deterministic;
  if (deterministicPolicy !== null) {
    if (deterministicPolicy.step_id !== step.id) fail('deterministic command policy is bound to the wrong step');
    const prefix = [deterministicPolicy.executable, ...deterministicPolicy.environment.map((item) => `${item.name}=${item.value}`), deterministicPolicy.interpreter, deterministicPolicy.script];
    if (step.command.length < prefix.length || prefix.some((item, index) => step.command[index] !== item)) {
      fail('deterministic workflow command drifted from the exact policy binding');
    }
  } else if (step.command[0] !== 'yy' || step.command[1] !== 'pi') {
    fail('model dispatch workflow command must be the canonical yy pi argument array');
  } else if (step.command.includes(ENVELOPE_FLAG)) {
    fail('model dispatch workflow command must not carry the benchmark envelope transport flag');
  }
  return step;
}

function executeStep(invocation, step) {
  const deterministicPolicy = step.deterministic;
  const runId = `${synthetic ? 'synthetic-run' : 'run'}-${String(invocation.dispatch_id).replace(/^sha256:/u, '').slice(0, 16)}`;
  const startedAt = new Date();
  const monotonic = process.hrtime.bigint();

  if (synthetic) {
    const endedAt = new Date();
    const runtimeMs = Number((process.hrtime.bigint() - monotonic) / 1_000_000n);
    return {
      dispatch_id: invocation.dispatch_id, status: 'success', effect: 'completed', runner_run_id: runId,
      observed_provider: invocation.provider, observed_model: invocation.model, observed_juno_version: invocation.juno_version,
      evidence: {
        outer_session_id: `synthetic-session-${String(invocation.dispatch_id).replace(/^sha256:/u, '').slice(0, 16)}`,
        nested_session_ids: [`synthetic-nested-${String(invocation.dispatch_id).replace(/^sha256:/u, '').slice(0, 16)}`],
        started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), runtime_ms: runtimeMs,
        cost: { completeness: 'not_applicable', usd: null },
        candidate_outcome: { status: 'success' }, harness_validity: { status: 'valid', reason: null },
        transcript: `synthetic transport: no provider child was spawned\nstep: ${step.id}\nmodel: ${invocation.model}\nargv: ${step.command.map((item) => (item.length > 96 ? `${item.slice(0, 96)}…` : item)).join(' ')}`,
        artifacts: {},
      },
    };
  }

  const argv = deterministicPolicy === null
    // Benchmark-owned transport: exactly one envelope request flag in the
    // root/global position, added to the validated product-owned argv.
    ? [resolveExecutable(step.command[0]), ENVELOPE_FLAG, ...step.command.slice(1)]
    : [resolveExecutable(step.command[0]), ...step.command.slice(1)];
  const extraEnvironment = deterministicPolicy === null ? childCorrelationEnvironment(invocation)
    : Object.fromEntries(deterministicPolicy.environment.map((item) => [item.name, item.value]));
  const execution = runChild(argv, { timeoutMs: invocation.timeout_ms, extraEnvironment, captureEvidence: deterministicPolicy === null });
  return execution.then(({ outcome, stdout, stderr, evidence, overflow, timedOut }) => {
    const endedAt = new Date();
    const runtimeMs = Number((process.hrtime.bigint() - monotonic) / 1_000_000n);
    if (overflow) fail('workflow step output exceeded the bounded capture limit');
    if (timedOut) fail(`workflow step ${step.id} timed out before terminal evidence`);
    if (outcome.code === null && outcome.signal === null) fail(`workflow step ${step.id} closed without a terminal outcome`);
    const transcript = deterministicPolicy === null
      ? boundedTranscript(Buffer.concat([evidence, Buffer.from('\n[execution-envelope]\n'), stdout]), stderr)
      : boundedTranscript(stdout, stderr);
    if (deterministicPolicy !== null) {
      const success = outcome.code === 0;
      return {
        dispatch_id: invocation.dispatch_id, status: success ? 'success' : 'failure', effect: 'completed', runner_run_id: runId,
        observed_provider: invocation.provider, observed_model: invocation.model, observed_juno_version: invocation.juno_version,
        evidence: {
          outer_session_id: `boundary-${runId}`, nested_session_ids: [`process-${process.pid}`],
          started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), runtime_ms: runtimeMs,
          cost: { completeness: 'not_applicable', usd: null },
          candidate_outcome: { status: success ? 'success' : 'failure' },
          harness_validity: { status: 'valid', reason: null },
          transcript, candidate_response: stdout.toString('utf8'), artifacts: {},
        },
      };
    }
    const envelope = envelopeOf(stdout);
    const separator = invocation.model.indexOf('/');
    const provider = separator > 0 ? invocation.model.slice(0, separator) : '';
    const modelName = separator > 0 ? invocation.model.slice(separator + 1) : '';
    const exitLabel = `exit ${outcome.code ?? outcome.signal ?? 'unknown'}`;
    // A child that terminated with a known status but produced no valid
    // envelope is a terminal harness failure with retained redacted evidence,
    // never an intent-only ambiguous external effect: the child provably
    // completed, so recovery must reuse this terminal rather than redispatch.
    const harnessFailure = (reason) => ({
      dispatch_id: invocation.dispatch_id, status: 'failure', effect: 'completed', runner_run_id: runId,
      observed_provider: invocation.provider, observed_model: invocation.model, observed_juno_version: invocation.juno_version,
      evidence: {
        outer_session_id: `boundary-${runId}`, nested_session_ids: [`unavailable-${runId}`],
        started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), runtime_ms: runtimeMs,
        cost: { completeness: 'unavailable', usd: null },
        candidate_outcome: { status: 'failure' },
        harness_validity: { status: 'invalid', reason: `${reason} (${exitLabel})` },
        transcript, candidate_response: evidence.toString('utf8'), artifacts: {},
      },
    });
    if (envelope === null) return harnessFailure(`workflow step ${step.id} produced no ${ENVELOPE_SCHEMA} terminal identity`);
    if (envelope.provider !== provider || envelope.model !== modelName || envelope.juno_version !== invocation.juno_version) {
      return harnessFailure(`workflow step ${step.id} terminal identity does not match the exact requested provider/model/version`);
    }
    if (envelope.session_id === null || typeof envelope.session_id !== 'string' || envelope.session_id.trim() === '') {
      return harnessFailure(`workflow step ${step.id} reported no single provable session identity`);
    }
    const cost = envelope.cost !== undefined && envelope.cost !== null
      && ['complete', 'partial', 'unavailable', 'not_applicable'].includes(envelope.cost.completeness)
      ? envelope.cost : { completeness: 'unavailable', usd: null };
    const success = outcome.code === 0 && envelope.status === 'success';
    return {
      dispatch_id: invocation.dispatch_id, status: success ? 'success' : 'failure', effect: 'completed', runner_run_id: runId,
      observed_provider: provider, observed_model: invocation.model, observed_juno_version: envelope.juno_version,
      evidence: {
        outer_session_id: envelope.session_id, nested_session_ids: [envelope.session_id],
        started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), runtime_ms: runtimeMs,
        cost, candidate_outcome: { status: success ? 'success' : 'failure' },
        harness_validity: { status: 'valid', reason: null }, transcript,
        candidate_response: evidence.toString('utf8'), artifacts: {},
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Protocol operations.
// ---------------------------------------------------------------------------

async function main() {
  if (operation === 'probe') {
    if (Object.keys(request).some((key) => key !== 'schema_version') || request.schema_version !== PROTOCOL) fail('probe request is invalid');
    process.stdout.write(JSON.stringify({ schema_version: PROTOCOL, providers: Object.keys(PROVIDER_CREDENTIALS) }));
    return;
  }

  if (operation === 'preflight') {
    const invocation = invocationOf(request);
    const provider = invocation.provider;
    const model = invocation.model;
    const junoVersion = invocation.juno_version;
    if (!isNonEmpty(provider) || !isNonEmpty(model) || !isNonEmpty(junoVersion)) fail('preflight identity is incomplete');
    if (model.includes('/')) {
      const separator = model.indexOf('/');
      if (model.slice(0, separator) !== provider) fail('preflight provider does not match the exact model identity');
    }
    credentialFor(provider);
    const observed = probeJunoVersion();
    if (observed !== junoVersion) fail(`YYLO version mismatch: invocation requires ${junoVersion}, executable reports ${observed}`);
    if (invocation.workflow_bytes_base64 !== undefined) {
      validatedStepFor(invocation, request.runtime_variables ?? {}, request.allow_step_references === true);
    }
    process.stdout.write(JSON.stringify({ ok: true, provider, model: model.includes('/') ? model.slice(model.indexOf('/') + 1) : model, juno_version: observed }));
    return;
  }

  if (operation === 'reconcile') {
    const invocation = invocationOf(request);
    for (const field of ['dispatch_id', 'invocation_hash', 'plan_id', 'step_id', 'model', 'provider', 'attempt']) {
      if (invocation[field] === undefined) fail(`reconcile invocation is missing ${field}`);
    }
    if (!isHash(invocation.dispatch_id) || !isHash(invocation.invocation_hash)) fail('reconcile invocation identity is invalid');
    const intent = readIntent(invocation);
    if (intent === null) { process.stdout.write(JSON.stringify({ state: 'proven_not_dispatched' })); return; }
    const terminal = readTerminal(invocation);
    if (terminal !== null) { process.stdout.write(JSON.stringify({ state: 'terminal', result: terminal })); return; }
    const deterministic = invocation.deterministic_command ?? null;
    const resumable = deterministic !== null || synthetic;
    process.stdout.write(JSON.stringify({ state: resumable ? 'safely_resumable' : 'ambiguous' }));
    return;
  }

  if (operation === 'dispatch' || operation === 'resume') {
    const invocation = invocationOf(request);
    for (const field of ['dispatch_id', 'invocation_hash', 'plan_id', 'model', 'provider', 'attempt', 'step_id', 'workflow_sha256', 'workflow_bytes_base64', 'timeout_ms', 'juno_version']) {
      if (invocation[field] === undefined) fail(`dispatch invocation is missing ${field}`);
    }
    if (!isHash(invocation.dispatch_id) || !isHash(invocation.invocation_hash) || !isHash(invocation.workflow_sha256)) fail('dispatch invocation identity is invalid');
    if (!Number.isInteger(invocation.timeout_ms) || invocation.timeout_ms <= 0) fail('dispatch invocation timeout is invalid');
    const priorTerminal = readTerminal(invocation);
    if (priorTerminal !== null) { process.stdout.write(JSON.stringify(priorTerminal)); return; }
    // Resolve and fully validate the compiled workflow command before any
    // durable intent: validation rejection stays proven_not_dispatched.
    const step = validatedStepFor(invocation, request.runtime_variables ?? {}, false);
    const recorded = recordIntent(invocation);
    if (recorded === 'terminal') { process.stdout.write(JSON.stringify(readTerminal(invocation))); return; }
    if (recorded === 'intent') {
      if (operation === 'dispatch') fail('a prior dispatch intent exists without terminal evidence; reconcile before any re-dispatch');
      // resume falls through: reconcile already proved the step safely resumable.
    }
    const result = await executeStep(invocation, step);
    recordTerminal(invocation, result);
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (operation === 'judge') {
    const invocation = invocationOf(request);
    const judge = invocation.judge;
    const scoringId = invocation.scoring_id;
    const blinded = invocation.blinded_candidate;
    if (judge === null || typeof judge !== 'object' || !isNonEmpty(judge.model) || !isNonEmpty(scoringId) || !isNonEmpty(blinded)) {
      fail('judge invocation is incomplete');
    }
    if (blinded.length > MAX_TRANSCRIPT_BYTES) fail('blinded candidate exceeds the bounded judgement input');
    const separator = judge.model.indexOf('/');
    const provider = separator > 0 ? judge.model.slice(0, separator) : 'governed';
    credentialFor(provider === 'governed' ? judge.model : provider);
    if (synthetic) {
      process.stdout.write(JSON.stringify({
        resolved: true,
        evidence: `synthetic governed judgement for ${scoringId} (judge ${judge.judge_id ?? 'governed'} v${judge.judge_version ?? '1'}, blinded digest sha256:${sha256Hex(Buffer.from(blinded, 'utf8'))})`,
      }));
      return;
    }
    const prompt = [
      'You are the governed YYLO Benchmark judge for one blinded candidate step.',
      'Judge only the retained candidate evidence below. Do not attempt to identify the producing model, provider, or candidate run.',
      `Scoring identity: ${scoringId}.`,
      `Judge policy: judge_id=${judge.judge_id ?? 'governed'} judge_version=${judge.judge_version ?? '1'} rubric_hash=${judge.rubric_hash ?? 'unspecified'}.`,
      'Reply with a short factual justification, then end your reply with exactly one final line that is either VERDICT: PASS or VERDICT: FAIL.',
      'Blinded candidate evidence follows:',
      blinded,
    ].join('\n');
    const execution = runChild([junoExecutable, 'pi', '--model', judge.model, prompt], { timeoutMs: Number(environment.YYLO_BENCHMARK_BOUNDARY_JUDGE_TIMEOUT_MS ?? 0) > 0 ? Number(environment.YYLO_BENCHMARK_BOUNDARY_JUDGE_TIMEOUT_MS) : 600_000 });
    const { outcome, stdout, stderr, overflow, timedOut } = await execution;
    if (overflow) fail('judge output exceeded the bounded capture limit');
    if (timedOut) fail('judge dispatch timed out before terminal evidence');
    const text = boundedTranscript(stdout, stderr);
    const verdicts = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line === 'VERDICT: PASS' || line === 'VERDICT: FAIL');
    const verdict = verdicts.at(-1);
    if (verdict === undefined || outcome.code !== 0) {
      process.stdout.write(JSON.stringify({ resolved: false, evidence: `governed judge produced no strict verdict (exit ${outcome.code ?? outcome.signal ?? 'unknown'}); retained tail: ${text.slice(-2048)}` }));
      return;
    }
    process.stdout.write(JSON.stringify({ resolved: verdict === 'VERDICT: PASS', evidence: `governed judge verdict ${verdict} for ${scoringId}; retained tail: ${text.slice(-2048)}` }));
    return;
  }

  fail(`unhandled operation ${operation}`);
}

main().catch((error) => { fail(error instanceof Error ? error.message : String(error)); });
