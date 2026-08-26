import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../src/cli/program.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(packageRoot, relative), 'utf8')) as Record<string, unknown>;
}

// This is the release guard for the YYLO Benchmark package identity. The rc.6
// dist shipped a hardcoded PACKAGE_VERSION constant left at rc.5, so the
// installed `yylo-benchmark --version` could never satisfy the CLI delegate
// pin even though package.json was correct. The version must now be derived
// from package.json at build time (tsup define for dist, vitest define for
// source-run tests), and this guard refuses any future drift across the
// derived constant, the manifest, the lockfile, and the CLI pin.
describe('package version identity', () => {
  it('derives PACKAGE_VERSION from package.json at build time', () => {
    const manifest = readJson('package.json');
    expect(PACKAGE_VERSION).toBe(manifest['version']);
    // A stale or missing injection must never masquerade as a real version.
    expect(PACKAGE_VERSION).not.toBe('0.0.0-unbuilt');
    expect(PACKAGE_VERSION).toMatch(/^0\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('keeps package-lock.json synchronized with package.json', () => {
    const lock = readJson('package-lock.json') as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    const manifest = readJson('package.json');
    expect(lock['version']).toBe(manifest['version']);
    expect(lock['packages']?.['']?.['version']).toBe(manifest['version']);
  });

  it('wires the injection token through both build configurations', () => {
    // The dist path is exercised by tsup; source-run tests by vitest. Both
    // must keep defining the exact token consumed by src/cli/program.ts so
    // neither surface can silently fall back to the unbuilt sentinel.
    const tsup = readFileSync(path.join(packageRoot, 'tsup.config.ts'), 'utf8');
    const vitest = readFileSync(path.join(packageRoot, 'vitest.config.ts'), 'utf8');
    const program = readFileSync(path.join(packageRoot, 'src/cli/program.ts'), 'utf8');
    expect(program).toContain('__YYLO_BENCHMARK_PACKAGE_VERSION__');
    for (const config of [tsup, vitest]) {
      expect(config).toContain('__YYLO_BENCHMARK_PACKAGE_VERSION__');
      expect(config).toMatch(/JSON\.stringify\(packageVersion\)/);
      expect(config).toMatch(/readFileSync\(new URL\('\.\/package\.json', import\.meta\.url\)/);
    }
  });

  it('pins the juno-code CLI delegate to this benchmark version', () => {
    // The `yy benchmark` delegate only accepts the exact version recorded in
    // juno-code's yyloBenchmark pin, so a benchmark bump without the pin (or
    // the reverse) ships a pair that can never pass the compatibility probe.
    // This repository is published both as the monorepo and as a standalone
    // subtree; the pin is only observable in the monorepo shape.
    const cliManifestPath = path.resolve(packageRoot, '../juno-code/package.json');
    let cliManifest: Record<string, unknown>;
    try {
      cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // standalone subtree shape
      throw error;
    }
    const pin = (cliManifest['yyloBenchmark'] as { version?: string } | undefined)?.['version'];
    expect(pin, 'juno-code yyloBenchmark pin must equal @yylo/benchmark package.json version').toBe(
      readJson('package.json')['version'],
    );
  });
});
