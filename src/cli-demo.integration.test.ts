/**
 * `archrad demo` is the first command a new user runs. It must work with zero
 * arguments from any working directory, because after `npm install -g` there is
 * no `fixtures/` directory in the caller's CWD.
 *
 * A previous README told users to run `--ir fixtures/demo-direct-db-violation.json`,
 * which only resolves from a git clone. These tests exist so that regression
 * cannot happen silently again.
 *
 * Spawns built `dist/cli.js` (npm test runs `npm run build` first).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');

/** An empty directory with no IR, no fixtures, no archrad.yml — a new user's shell. */
const elsewhere = mkdtempSync(join(tmpdir(), 'archrad-demo-cwd-'));

afterAll(() => {
  try {
    rmSync(elsewhere, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function runDemo(args: string[] = []) {
  if (!existsSync(cliJs)) return null;
  return spawnSync(process.execPath, [cliJs, 'demo', ...args], {
    cwd: elsewhere,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('archrad demo', () => {
  it('runs with zero arguments from an unrelated working directory', () => {
    const r = runDemo();
    expect(r).not.toBeNull();
    expect(r!.status).toBe(0);
  });

  it('does not report a missing --ir file (the bundled fixture must resolve)', () => {
    const r = runDemo();
    const output = `${r!.stdout ?? ''}${r!.stderr ?? ''}`;
    expect(output).not.toMatch(/file not found/i);
    expect(output).not.toMatch(/could not be read/i);
  });

  it('surfaces the direct-DB-access finding', () => {
    const r = runDemo();
    expect(r!.stderr).toContain('IR-LINT-DIRECT-DB-ACCESS-002');
  });

  it('exits 0 so a first run never looks broken', () => {
    // The demo is an introduction, not a gate. `validate` is the gate.
    const r = runDemo();
    expect(r!.status).toBe(0);
  });

  it('--json emits a parseable findings array on stdout', () => {
    const r = runDemo(['--json']);
    expect(r!.status).toBe(0);
    const parsed = JSON.parse(r!.stdout) as Array<{ code: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((f) => f.code)).toContain('IR-LINT-DIRECT-DB-ACCESS-002');
  });

  it('is deterministic — two runs produce identical findings', () => {
    const a = runDemo(['--json']);
    const b = runDemo(['--json']);
    expect(a!.stdout).toBe(b!.stdout);
  });

  it('is listed in top-level help so new users can find it', () => {
    const r = spawnSync(process.execPath, [cliJs, '--help'], {
      cwd: elsewhere,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(r.stdout).toContain('demo');
  });
});
