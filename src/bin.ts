#!/usr/bin/env node
import { runCli } from './cli/program.js';

runCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`juno-benchmark: ${message}\n`);
  process.exitCode = 1;
});
