/**
 * Spawns built `dist/cli.js` — run `npm run build` first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');
const backstageDemo = join(pkgRoot, 'fixtures', 'backstage', 'demo');
const composeDemo = join(pkgRoot, 'fixtures', 'docker-compose', 'demo-direct-db.yml');
const minimal = join(pkgRoot, 'fixtures', 'minimal-graph.json');
const ecommerce = join(pkgRoot, 'fixtures', 'ecommerce-with-warnings.json');

function run(args: string[]): { status: number | null; stderr: string; stdout: string } {
  if (!existsSync(cliJs)) return { status: null, stderr: '', stdout: '' };
  const r = spawnSync(process.execPath, [cliJs, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

describe('ingest + fragment CLI (integration)', () => {
  it('ingest backstage produces IR and exits 0', () => {
    const out = join(pkgRoot, 'dist-ingest-backstage-test.json');
    try {
      const r = run(['ingest', 'backstage', '--catalog', backstageDemo, '-o', out]);
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      const j = JSON.parse(readFileSync(out, 'utf8')) as { graph?: { nodes?: unknown[] } };
      expect((j.graph?.nodes ?? []).length).toBeGreaterThan(0);
    } finally {
      if (existsSync(out)) unlinkSync(out);
    }
  });

  it('init from docker-compose writes IR and validate runs', () => {
    const out = join(pkgRoot, 'dist-init-compose-test.json');
    try {
      const r = run(['init', '--from', composeDemo, '-o', out]);
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      const v = run(['validate', '--ir', out]);
      expect(v.status).toBe(0);
      expect(v.stderr + v.stdout).toMatch(/IR-LINT-DIRECT-DB-ACCESS-002/);
    } finally {
      if (existsSync(out)) unlinkSync(out);
    }
  }, 20000);

  it('fragment merge + validate exits 0', () => {
    const out = join(pkgRoot, 'dist-fragment-merge-test.json');
    try {
      const r = run(['fragment', 'merge', '-f', minimal, ecommerce, '-o', out]);
      expect(r.status).toBe(0);
      const v = run(['validate', '--ir', out]);
      expect(v.status).toBe(0);
    } finally {
      if (existsSync(out)) unlinkSync(out);
    }
  }, 20000);
});
