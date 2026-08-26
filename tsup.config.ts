import { cp, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts', 'src/boundary/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // The dist must self-report exactly the released package.json version, so
  // the CLI delegate pair check cannot be satisfied by a stale constant.
  define: { __YYLO_BENCHMARK_PACKAGE_VERSION__: JSON.stringify(packageVersion) },
  // Markdown and the reviewed boundary module are runtime package data
  // rather than JavaScript imports, so tsup cannot discover them automatically.
  // Keep the installed package independent of a source checkout by copying
  // managed wiki templates and the reviewed boundary bytes under dist, which is
  // already the declared package surface.
  onSuccess: async () => {
    const wikiDestination = path.resolve('dist/templates/wiki');
    await mkdir(wikiDestination, { recursive: true });
    await cp(path.resolve('src/templates/wiki'), wikiDestination, { recursive: true });
    const boundaryDestination = path.resolve('dist/boundary');
    await mkdir(boundaryDestination, { recursive: true });
    await cp(path.resolve('boundary'), boundaryDestination, { recursive: true });
  },
});
