import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // The CLI delegate compatibility check must observe the exact packed version.
  define: { __YYLO_BENCHMARK_PACKAGE_VERSION__: JSON.stringify(packageVersion) },
});
