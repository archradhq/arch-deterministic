/**
 * Filesystem walker for source-code reconstruction.
 * Skips test files, build artifacts, documentation, and examples.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  // Yarn Berry vendors its own release bundle and dependency cache in-repo.
  '.yarn',
  '.pnp',
  '__pycache__',
  '.git',
  '.svn',
  '.hg',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'target',
  'bin',
  'obj',
  '.cache',
  'coverage',
  '.nyc_output',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'examples',
  'example',
  'samples',
  'sample',
  'docs',
  '.venv',
  'venv',
  'env',
  '.env',
  'vendor',
]);

/** Path-segment patterns that flag a file as a test or example. */
const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /[/\\](tests?|specs?|__tests?__)[/\\]/i,
  /[/\\](examples?|samples?|docs?|fixtures?)[/\\]/i,
  /\.(test|spec)\.[jt]sx?$/i,
  /\.stories?\.[jt]sx?$/i,
  /\.(test|spec)\.py$/i,
  /[/\\]test_[^/\\]+\.py$/i,
  /_test\.py$/i,
  /[/\\]Test[A-Z][^/\\]*\.cs$/i,
  /Tests?\.cs$/i,
  /\.integration\.test\.[jt]sx?$/i,
];

export function shouldExclude(relPath: string, extraPatterns: string[] = []): boolean {
  const norm = relPath.replace(/\\/g, '/');
  const parts = norm.split('/');

  for (let i = 0; i < parts.length - 1; i++) {
    if (EXCLUDED_DIRS.has((parts[i] ?? '').toLowerCase())) return true;
  }

  const withSlash = `/${norm}`;
  for (const pat of EXCLUDED_PATH_PATTERNS) {
    if (pat.test(withSlash)) return true;
  }

  for (const extra of extraPatterns) {
    if (norm.includes(extra)) return true;
  }

  return false;
}

export type ScannedFile = {
  relPath: string;
  content: string;
};

export async function walkFiles(
  rootDir: string,
  extensions: string[],
  extraExclude?: string[],
): Promise<ScannedFile[]> {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const results: ScannedFile[] = [];

  async function recurse(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const rel = full.slice(rootDir.length).replace(/^[/\\]/, '').replace(/\\/g, '/');

      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.has(ent.name.toLowerCase())) continue;
        await recurse(full);
      } else if (ent.isFile()) {
        if (!extSet.has(extname(ent.name).toLowerCase())) continue;
        if (shouldExclude(rel, extraExclude)) continue;
        try {
          const content = await readFile(full, 'utf8');
          results.push({ relPath: rel, content });
        } catch {
          // binary or permission-denied — skip
        }
      }
    }
  }

  await recurse(rootDir);
  return results;
}
