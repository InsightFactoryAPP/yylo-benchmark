import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Markdown is runtime package data rather than a JavaScript import, so tsup
  // cannot discover it automatically. Keep the installed package independent of
  // a source checkout by copying managed wiki templates under dist.
  onSuccess: async () => {
    const destination = path.resolve('dist/templates/wiki');
    await mkdir(destination, { recursive: true });
    await cp(path.resolve('src/templates/wiki'), destination, { recursive: true });
  },
});
