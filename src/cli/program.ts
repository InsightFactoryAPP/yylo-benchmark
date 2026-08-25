import { Command } from 'commander';
import { registerBuiltinCommands } from './builtins.js';
import { CommandRegistry, type BenchmarkPlugin, type CommandContext } from './registry.js';

export const PACKAGE_VERSION = '0.1.0-rc.5';

export interface ProgramOptions {
  readonly cwd?: string;
  readonly plugins?: readonly BenchmarkPlugin[];
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export function createCommandRegistry(plugins: readonly BenchmarkPlugin[] = []): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  for (const plugin of plugins) registry.registerPlugin(plugin);
  return registry;
}

export function createProgram(options: ProgramOptions = {}): Command {
  const root = new Command();
  root
    .name('yylo-benchmark')
    .description('Immutable task-case and project-owned workflow evaluation')
    .showHelpAfterError('Run yylo-benchmark --help for supported commands.')
    .version(PACKAGE_VERSION)
    .option('--config <path>', 'Use an explicit yylo-benchmark.config.json');

  const context: CommandContext = {
    cwd: options.cwd ?? process.cwd(),
    get configPath(): string | undefined {
      return root.opts<{ config?: string }>().config;
    },
    writeStdout: options.stdout ?? ((text) => process.stdout.write(text)),
    writeStderr: options.stderr ?? ((text) => process.stderr.write(text)),
  };
  const parents = new Map<string, Command>([['', root]]);
  for (const definition of createCommandRegistry(options.plugins).definitions()) {
    let parent = root;
    for (let index = 0; index < definition.path.length - 1; index += 1) {
      const prefix = definition.path.slice(0, index + 1).join(' ');
      let nested = parents.get(prefix);
      if (nested === undefined) {
        const part = definition.path[index];
        if (part === undefined) throw new Error('invalid empty command path');
        nested = parent.command(part);
        parents.set(prefix, nested);
      }
      parent = nested;
    }
    const name = definition.path.at(-1);
    if (name === undefined) throw new Error('invalid empty command path');
    const leaf = parent.command(name).description(
      definition.available ? definition.description : `${definition.description} (reserved; unavailable)`,
    );
    definition.configure(leaf, context);
  }
  return root;
}

export async function runCli(argv: readonly string[], options: ProgramOptions = {}): Promise<void> {
  const registry = createCommandRegistry(options.plugins); const supported = new Set(registry.definitions().map((item) => item.path[0]));
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--config') { index += 1; continue; }
    if (token.startsWith('--config=') || token === '--help' || token === '-h' || token === '--version' || token === '-V') continue;
    if (!token.startsWith('-')) { command = token; break; }
  }
  if (command !== undefined && !supported.has(command)) throw new Error(`unknown command '${command}'; run yylo-benchmark --help for plan, run, recover, and rejudge`);
  await createProgram(options).parseAsync([...argv], { from: 'user' });
}
