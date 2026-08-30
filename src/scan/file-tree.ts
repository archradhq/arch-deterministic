/**
 * Deterministic repository file tree for `archrad scan`.
 *
 * Unlike the reconstruct walker (which is source-code / extension filtered), scan
 * needs to see every file so topology, interface, and manifest extractors can
 * find their targets. Files are returned sorted by relPath and read lazily +
 * cached so `Extractor.extract` can stay a pure synchronous function.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ScanFile, ScanFileTree } from './types.js';

/** Directories never worth scanning (build output, VCS, deps). */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'coverage',
  '.nyc_output',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'vendor',
  // Yarn Berry vendors its own release and its dependency cache into the repo.
  // cal.com commits .yarn/releases/yarn-4.12.0.cjs — 2.9 MB of minified bundle
  // that the code extractor happily read, inventing a "TypeORM" postgres node
  // out of a string inside Yarn itself.
  '.yarn',
  '.pnp',
  '.gradle',
  '.terraform',
]);

/**
 * Directories holding test material rather than the system being described.
 *
 * A repository's fixtures are not its architecture. argo-cd keeps Kubernetes
 * YAML for its unit tests, and scanning it produced 169 nodes of which 47 —
 * better than a quarter — were pods and jobs that exist only to be asserted
 * against: `service_never_ready`, `worker_fail`, deployments named for the
 * failure mode they reproduce. They crowd out the real components and light up
 * the lint rules, because a fixture is disconnected by design.
 *
 * `testdata` is Go's convention and the worst offender; the rest are the common
 * equivalents. Deliberately NOT excluded: `examples`, which in most repositories
 * is a real deployment someone is expected to run.
 */
const TEST_DIRS = new Set(['testdata', 'test-data', '__tests__', '__fixtures__', '__mocks__', 'fixtures']);

/** Unambiguous non-production path segments used only by the opt-in production view. */
const NON_PRODUCTION_DIRS = new Set([
  'test',
  'tests',
  'e2e',
  'examples',
  'example',
  'docs',
  'doc',
  'dev',
  'demo',
  'demos',
  'sample',
  'samples',
  'storybook',
]);

function isProductionExcludedDir(name: string): boolean {
  const lower = name.toLowerCase();
  return NON_PRODUCTION_DIRS.has(lower) || /(?:^|[-_])(tests?|examples?|fixtures?)$/.test(lower);
}

function isProductionExcludedFile(name: string): boolean {
  return /\.(?:stories?|spec|test)\.[^.]+$/i.test(name);
}

/**
 * Whether `name` is a test directory in a position that makes it one.
 *
 * `test`/`tests`/`e2e` are only treated as test roots at the top level of the
 * repository — nested, the name is too common to trust, and a service genuinely
 * called `tests` deep in a tree should not vanish.
 */
function isTestDir(name: string, relDir: string): boolean {
  if (TEST_DIRS.has(name)) return true;
  return relDir === '' && (name === 'test' || name === 'tests' || name === 'e2e');
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Build a {@link ScanFileTree} for `rootDir`. `extraExclude` fragments exclude
 * any relPath that contains them (substring match, POSIX-normalized).
 */
export function buildScanFileTree(
  rootDir: string,
  extraExclude: string[] = [],
  scope: 'all' | 'production' = 'all',
): ScanFileTree {
  const root = resolve(rootDir);
  const files: ScanFile[] = [];

  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort entries so traversal order (and thus `files`) is deterministic across
    // platforms/filesystems.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const rel = toPosix(full.slice(root.length).replace(/^[/\\]/, ''));
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.has(ent.name.toLowerCase())) continue;
        if (scope === 'production' && isProductionExcludedDir(ent.name)) continue;
        // `rel` is the directory itself, so its parent is what decides whether
        // a bare `test`/`e2e` sits at the repository root.
        const parentRel = rel.slice(0, Math.max(0, rel.length - ent.name.length - 1));
        if (isTestDir(ent.name.toLowerCase(), parentRel)) continue;
        walk(full);
      } else if (ent.isFile()) {
        if (scope === 'production' && isProductionExcludedFile(ent.name)) continue;
        if (extraExclude.some((frag) => frag && rel.includes(frag))) continue;
        files.push({ relPath: rel, absPath: full });
      }
    }
  };

  walk(root);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const cache = new Map<string, string>();
  const byRel = new Map<string, string>(files.map((f) => [f.relPath, f.absPath]));

  const read = (relPath: string): string => {
    const key = toPosix(relPath);
    if (cache.has(key)) return cache.get(key)!;
    const abs = byRel.get(key);
    let content = '';
    if (abs) {
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        content = '';
      }
    }
    cache.set(key, content);
    return content;
  };

  return { root, files, read };
}
