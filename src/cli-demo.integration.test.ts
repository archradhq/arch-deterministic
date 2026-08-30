/**
 * `archrad demo` is the first command a new user runs. It must work with zero
 * arguments from any working directory, because after `npm install -g` there is
 * no `fixtures/` directory in the caller's CWD.
 *
 * A previous README told users to run `--ir fixtures/demo-direct-db-violation.json`,
 * which only resolves from a git clone. These tests exist so that regression
 * cannot happen silently again.
 *
 * Spawns built `dist/cli.js` (npm test runs `npm run build` first). Each spawn is
 * done once in `beforeAll` and shared across assertions: spawning per-test made
 * the suite flaky under vitest's parallel file execution, and a flaky test in a
 * package that sells determinism is worse than no test.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');

/** An empty directory with no IR, no fixtures, no archrad.yml — a new user's shell. */
const elsewhere = mkdtempSync(join(tmpdir(), 'archrad-demo-cwd-'));

function run(args: string[]): SpawnSyncReturns<string> {
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    cwd: elsewhere,
    encoding: 'utf8',
    windowsHide: true,
  });
  // Surface spawn-level failures (EAGAIN under parallel load, missing build)
  // instead of letting them show up later as a confusing empty-output diff.
  if (r.error) throw new Error(`spawn failed for [${args.join(' ')}]: ${r.error.message}`);
  return r;
}

let plain: SpawnSyncReturns<string>;
let json1: SpawnSyncReturns<string>;
let json2: SpawnSyncReturns<string>;
let help: SpawnSyncReturns<string>;

beforeAll(() => {
  if (!existsSync(cliJs)) throw new Error(`dist/cli.js not built at ${cliJs} — run npm run build`);
  plain = run(['demo']);
  json1 = run(['demo', '--json']);
  json2 = run(['demo', '--json']);
  help = run(['--help']);
});

afterAll(() => {
  try {
    rmSync(elsewhere, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('archrad demo', () => {
  it('runs with zero arguments from an unrelated working directory', () => {
    expect(plain.status).toBe(0);
  });

  it('does not report a missing --ir file (the bundled fixture must resolve)', () => {
    const output = `${plain.stdout ?? ''}${plain.stderr ?? ''}`;
    expect(output).not.toMatch(/file not found/i);
    expect(output).not.toMatch(/could not be read/i);
  });

  it('surfaces the direct-DB-access finding', () => {
    expect(plain.stderr).toContain('IR-LINT-DIRECT-DB-ACCESS-002');
  });

  it('exits 0 so a first run never looks broken', () => {
    // The demo is an introduction, not a gate. `validate` is the gate.
    expect(plain.status).toBe(0);
  });

  it('--json emits a parseable findings array on stdout', () => {
    expect(json1.status).toBe(0);
    const parsed = JSON.parse(json1.stdout) as Array<{ code: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((f) => f.code)).toContain('IR-LINT-DIRECT-DB-ACCESS-002');
  });

  it('is deterministic — two runs produce identical findings', () => {
    // Assert both runs succeeded before diffing, so a spawn hiccup reports as
    // "exit N" rather than as a bogus determinism failure.
    expect(json1.status).toBe(0);
    expect(json2.status).toBe(0);
    expect(json1.stdout.trim()).not.toBe('');
    expect(JSON.parse(json2.stdout)).toEqual(JSON.parse(json1.stdout));
  });

  it('is listed in top-level help so new users can find it', () => {
    expect(help.stdout).toContain('demo');
  });
});
