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
]);

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Build a {@link ScanFileTree} for `rootDir`. `extraExclude` fragments exclude
 * any relPath that contains them (substring match, POSIX-normalized).
 */
export function buildScanFileTree(rootDir: string, extraExclude: string[] = []): ScanFileTree {
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
        walk(full);
      } else if (ent.isFile()) {
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
