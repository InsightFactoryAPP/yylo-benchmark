import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCommandRegistry, runCli } from '../src/cli/program.js';
import { COMMAND_API_VERSION, PLUGIN_API_VERSION, type BenchmarkPlugin } from '../src/cli/registry.js';

const plugin: BenchmarkPlugin = {
  api_version: PLUGIN_API_VERSION,
  id: 'fixture',
  commands: [{
    api_version: COMMAND_API_VERSION,
    path: ['fixture'],
    description: 'fixture command',
    phase: 'foundation',
    available: true,
    configure(command) { command.action(() => undefined); },
  }],
};

describe('command and plugin registration', () => {
  it('predeclares the complete v1 command surface', () => {
    const definitions = createCommandRegistry().definitions();
    expect(definitions.map((item) => item.path.join(' '))).toEqual([
      'init', 'case lint', 'setup', 'readiness', 'plan', 'run', 'recover', 'rejudge', 'regrade', 'doctor', 'report', 'investigate', 'release-readiness',
    ]);
    expect(definitions.filter((item) => item.available).map((item) => item.path.join(' '))).toEqual([
      'init', 'case lint', 'setup', 'readiness', 'plan', 'run', 'recover', 'rejudge', 'regrade', 'doctor', 'report', 'investigate', 'release-readiness',
    ]);
    expect(Object.isFrozen(definitions[0])).toBe(true);
    expect(Object.isFrozen(definitions[0]?.path)).toBe(true);
  });

  it('initializes configuration and packaged managed guidance together', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-init-')); const output: string[] = [];
    await runCli(['init'], { cwd: root, stdout: (text) => output.push(text) });
    expect(JSON.parse(await readFile(path.join(root, 'yylo-benchmark.config.json'), 'utf8'))).toMatchObject({ schema_version: 'juno_benchmark_config.v1' });
    expect(await readFile(path.join(root, '.juno_task/wiki/yylo-benchmark/overview.md'), 'utf8')).toContain('wiki_contract');
    expect(output.join('')).toContain('yylo-benchmark.config.json');
  });

  it('allows versioned extensions but refuses collisions', () => {
    expect(createCommandRegistry([plugin]).definitions().at(-1)?.path).toEqual(['fixture']);
    expect(() => createCommandRegistry([{ ...plugin, id: 'collision', commands: [{ ...plugin.commands[0]!, path: ['plan'] }] }])).toThrow(/already registered/u);
  });
});
