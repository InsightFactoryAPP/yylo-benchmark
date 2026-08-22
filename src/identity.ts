/** Bounded 0.1 RC migration from the former benchmark environment prefix. */
export function migrateLegacyBenchmarkEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  for (const [legacyName, value] of Object.entries(environment)) {
    if (!legacyName.startsWith('JUNO_BENCHMARK_') || value === undefined) continue;
    const canonicalName = `YYLO_BENCHMARK_${legacyName.slice('JUNO_BENCHMARK_'.length)}`;
    if (environment[canonicalName] === undefined) environment[canonicalName] = value;
  }
}
