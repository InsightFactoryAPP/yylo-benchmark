import type { Command } from 'commander';

export const COMMAND_API_VERSION = 'juno_benchmark_command_api.v1' as const;
export const PLUGIN_API_VERSION = 'juno_benchmark_plugin_api.v1' as const;

export type CommandPhase = 'foundation' | 'snapshot' | 'control-plane' | 'execution' | 'longitudinal';

export interface CommandContext {
  readonly cwd: string;
  readonly configPath: string | undefined;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface CommandDefinition {
  readonly api_version: typeof COMMAND_API_VERSION;
  readonly path: readonly [string, ...string[]];
  readonly description: string;
  readonly phase: CommandPhase;
  readonly available: boolean;
  configure(command: Command, context: CommandContext): void;
}

export interface BenchmarkPlugin {
  readonly api_version: typeof PLUGIN_API_VERSION;
  readonly id: string;
  readonly commands: readonly CommandDefinition[];
}

function commandKey(path: readonly string[]): string {
  return path.join(' ');
}

export class CommandRegistry {
  readonly #commands = new Map<string, Readonly<CommandDefinition>>();
  readonly #plugins = new Set<string>();

  public registerBuiltin(definition: CommandDefinition): void {
    this.register(`builtin:${commandKey(definition.path)}`, definition);
  }

  public registerPlugin(plugin: BenchmarkPlugin): void {
    if (plugin.api_version !== PLUGIN_API_VERSION) throw new Error(`unsupported plugin API: ${plugin.api_version}`);
    if (!/^[a-z][a-z0-9-]*$/u.test(plugin.id)) throw new Error(`invalid plugin ID: ${plugin.id}`);
    if (this.#plugins.has(plugin.id)) throw new Error(`plugin already registered: ${plugin.id}`);
    for (const definition of plugin.commands) this.assertCanRegister(definition);
    for (const definition of plugin.commands) this.register(`plugin:${plugin.id}`, definition);
    this.#plugins.add(plugin.id);
  }

  public definitions(): readonly Readonly<CommandDefinition>[] {
    return Object.freeze([...this.#commands.values()]);
  }

  private assertCanRegister(definition: CommandDefinition): void {
    if (definition.api_version !== COMMAND_API_VERSION) throw new Error(`unsupported command API: ${definition.api_version}`);
    if (definition.path.length === 0 || definition.path.some((part) => !/^[a-z][a-z0-9-]*$/u.test(part))) {
      throw new Error(`invalid command path: ${definition.path.join(' ')}`);
    }
    if (this.#commands.has(commandKey(definition.path))) throw new Error(`command already registered: ${commandKey(definition.path)}`);
  }

  private register(_owner: string, definition: CommandDefinition): void {
    this.assertCanRegister(definition);
    const frozen = Object.freeze({ ...definition, path: Object.freeze([...definition.path]) }) as Readonly<CommandDefinition>;
    this.#commands.set(commandKey(frozen.path), frozen);
  }
}
