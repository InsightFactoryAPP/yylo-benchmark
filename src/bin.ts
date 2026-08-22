#!/usr/bin/env node
import { runCli } from './cli/program.js';
import { migrateLegacyBenchmarkEnvironment } from './identity.js';

migrateLegacyBenchmarkEnvironment();

runCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`yylo-benchmark: ${message}\n`);
  process.exitCode = 1;
});
