import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BENCHMARK_WIKI_PAGES,
  hashProjectWikis,
  installBenchmarkWikis,
  normalizeProjectWikiPath,
} from '../../src/wiki/index.js';

const roots: string[] = [];
const packageRoot = path.resolve(import.meta.dirname, '../..');
const sourceTemplates = path.join(packageRoot, 'src/templates/wiki');
const junoLinter = path.resolve(packageRoot, '../.juno_task/scripts/wiki_lint.sh');

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'juno-benchmark-wiki-'));
  roots.push(root);
  return root;
}

async function templateCopy(): Promise<string> {
  const root = await temporaryRoot();
  const templates = path.join(root, 'templates');
  await cp(sourceTemplates, templates, { recursive: true });
  return templates;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe('managed benchmark wikis', () => {
  it('installs all package pages and leaves project pages untouched', async () => {
    const projectRoot = await temporaryRoot();
    const projectPage = path.join(projectRoot, '.juno_task/wiki/juno-benchmark/project/backend.md');
    await mkdir(path.dirname(projectPage), { recursive: true });
    await writeFile(projectPage, 'project knowledge\n');

    const result = await installBenchmarkWikis({ projectRoot });

    expect(result.installed).toHaveLength(BENCHMARK_WIKI_PAGES.length);
    expect(result.conflicts).toEqual([]);
    expect(await readFile(projectPage, 'utf8')).toBe('project knowledge\n');
    for (const page of BENCHMARK_WIKI_PAGES) {
      const installed = await readFile(path.join(projectRoot, '.juno_task/wiki/juno-benchmark', page), 'utf8');
      expect(installed).toContain('wiki_contract:');
    }
  });

  it('updates unchanged managed bytes and retains a checksum backup', async () => {
    const projectRoot = await temporaryRoot();
    const templates = await templateCopy();
    await installBenchmarkWikis({ projectRoot, templatesDirectory: templates });
    const destination = path.join(projectRoot, '.juno_task/wiki/juno-benchmark/overview.md');
    const oldBytes = await readFile(destination, 'utf8');
    await writeFile(path.join(templates, 'overview.md'), `${oldBytes}\nNew package guidance.\n`);

    const result = await installBenchmarkWikis({ projectRoot, templatesDirectory: templates });

    expect(result.updated).toContain('.juno_task/wiki/juno-benchmark/overview.md');
    const backup = result.backups.find((item) => item.destination.endsWith('/overview.md'));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(projectRoot, backup!.backup), 'utf8')).toBe(oldBytes);
    expect(await readFile(destination, 'utf8')).toContain('New package guidance.');
  });

  it('preserves customized pages and writes the package candidate as a conflict', async () => {
    const projectRoot = await temporaryRoot();
    const templates = await templateCopy();
    await installBenchmarkWikis({ projectRoot, templatesDirectory: templates });
    const destination = path.join(projectRoot, '.juno_task/wiki/juno-benchmark/case_authoring.md');
    await writeFile(destination, 'customized guidance\n');
    await writeFile(path.join(templates, 'case_authoring.md'), 'new package candidate\n');

    const result = await installBenchmarkWikis({ projectRoot, templatesDirectory: templates });

    expect(await readFile(destination, 'utf8')).toBe('customized guidance\n');
    const conflict = result.conflicts.find((item) => item.destination.endsWith('/case_authoring.md'));
    expect(conflict).toBeDefined();
    expect(await readFile(path.join(projectRoot, conflict!.candidate), 'utf8')).toBe('new package candidate\n');
  });

  it('does not adopt an untracked customized page', async () => {
    const projectRoot = await temporaryRoot();
    const destination = path.join(projectRoot, '.juno_task/wiki/juno-benchmark/model_comparison.md');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'local page\n');

    const result = await installBenchmarkWikis({ projectRoot });

    expect(await readFile(destination, 'utf8')).toBe('local page\n');
    expect(result.conflicts).toContainEqual(expect.objectContaining({
      destination: '.juno_task/wiki/juno-benchmark/model_comparison.md',
    }));
  });
});

describe('selected project wiki identity', () => {
  it('normalizes, lints through Juno wiki_contract, sorts, deduplicates, and hashes exact bytes', async () => {
    const projectRoot = await temporaryRoot();
    const first = `---\nwiki_contract:\n  line_limit: 30\n  purpose: "Explain backend evaluation constraints."\n  failure_mode_prevented: "Prevents invalid backend assumptions."\n  runtime_contract_enforced: "Backend checks use declared fixtures."\n  validation_gate: "focused backend checks"\n---\n\n# Backend\n\nStable project knowledge.\n`;
    const second = first.replaceAll('Backend', 'Frontend').replaceAll('backend', 'frontend');
    const projectDirectory = path.join(projectRoot, '.juno_task/wiki/juno-benchmark/project');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(path.join(projectDirectory, 'backend.md'), first);
    await writeFile(path.join(projectDirectory, 'frontend.md'), second);

    const result = await hashProjectWikis([
      'juno-benchmark/project/frontend.md',
      'juno-benchmark/project/backend.md',
      'juno-benchmark/project/backend.md',
    ], { projectRoot, linter: junoLinter });

    expect(result).toEqual([
      { path: 'juno-benchmark/project/backend.md', sha256: `sha256:${sha256(first)}` },
      { path: 'juno-benchmark/project/frontend.md', sha256: `sha256:${sha256(second)}` },
    ]);
  });

  it.each([
    '../outside.md',
    'juno-benchmark/overview.md',
    'juno-benchmark/project/../overview.md',
    '/juno-benchmark/project/page.md',
    'juno-benchmark\\project\\page.md',
    'juno-benchmark/project/page.txt',
    ' juno-benchmark/project/page.md',
  ])('rejects traversal or non-normalized path %s', (selected) => {
    expect(() => normalizeProjectWikiPath(selected)).toThrow();
  });

  it('rejects symbolic-link traversal even when the lexical path is confined', async () => {
    const projectRoot = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(outside, 'escaped.md'), '# escaped\n');
    const namespace = path.join(projectRoot, '.juno_task/wiki/juno-benchmark');
    await mkdir(namespace, { recursive: true });
    await symlink(outside, path.join(namespace, 'project'));

    await expect(hashProjectWikis(
      ['juno-benchmark/project/escaped.md'],
      { projectRoot, linter: junoLinter },
    )).rejects.toThrow(/symbolic link/u);
  });

  it('fails closed when the shared Juno linter rejects frontmatter', async () => {
    const projectRoot = await temporaryRoot();
    const projectDirectory = path.join(projectRoot, '.juno_task/wiki/juno-benchmark/project');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(path.join(projectDirectory, 'invalid.md'), '---\nwiki_contract:\n  line_limit: nope\n---\n# Invalid\n');

    await expect(hashProjectWikis(
      ['juno-benchmark/project/invalid.md'],
      { projectRoot, linter: junoLinter },
    )).rejects.toThrow(/wiki_contract lint failed/u);
  });
});
