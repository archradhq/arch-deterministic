/**
 * Spawns built `dist/cli.js` to verify the `archrad lint` and `archrad
 * explain` commands introduced in PR 8. `npm test` builds before running
 * vitest so the binary is always present.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');
const warningsOnly = join(pkgRoot, 'fixtures', 'ecommerce-with-warnings.json');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (!existsSync(cliJs)) {
    return { status: null, stdout: '', stderr: '' };
  }
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('archrad lint', () => {
  it('exits 0 with only warnings by default', () => {
    const r = runCli(['lint', '--no-config', '--ir', warningsOnly]);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('IR-LINT-');
  });

  it('exits 1 with --fail-on-warning when lint warnings present', () => {
    const r = runCli(['lint', '--no-config', '--ir', warningsOnly, '--fail-on-warning']);
    if (r.status === null) return;
    expect(r.status).toBe(1);
  });

  it('exits 1 for unparseable IR (never a silent pass)', () => {
    // `lint` intentionally skips IR-structural edge/ref checks (that's
    // `validate`'s job), but unparseable IR must still surface as a blocker
    // so users aren't misled by a zero-finding "clean" result.
    const bad = join(tmpdir(), `archrad-lint-bad-${Date.now()}.json`);
    writeFileSync(bad, '{}', 'utf8');
    try {
      const r = runCli(['lint', '--no-config', '--ir', bad]);
      if (r.status === null) return;
      expect(r.status).toBe(1);
    } finally {
      try {
        unlinkSync(bad);
      } catch {
        /* ignore */
      }
    }
  });

  it('emits a JSON array to stdout with --json', () => {
    const r = runCli(['lint', '--no-config', '--ir', warningsOnly, '--json']);
    if (r.status === null) return;
    const arr = JSON.parse(r.stdout) as { code: string }[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.some((x) => x.code.startsWith('IR-LINT-'))).toBe(true);
  });

  it('--rule filters to the requested code only (case-insensitive)', () => {
    const r = runCli([
      'lint',
      '--no-config',
      '--ir',
      warningsOnly,
      '--rule',
      'ir-lint-no-healthcheck-003',
      '--json',
    ]);
    if (r.status === null) return;
    const arr = JSON.parse(r.stdout) as { code: string }[];
    expect(arr.length).toBeGreaterThan(0);
    expect(arr.every((x) => x.code === 'IR-LINT-NO-HEALTHCHECK-003')).toBe(true);
  });

  it('prints a "no findings match rule filter" message when filter excludes all', () => {
    const r = runCli([
      'lint',
      '--no-config',
      '--ir',
      warningsOnly,
      '--rule',
      'IR-LINT-NOT-A-REAL-CODE',
    ]);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no findings match rule filter');
  });

  it('writes --metrics-file and --findings-json-out', () => {
    const metrics = join(tmpdir(), `archrad-lint-metrics-${Date.now()}.json`);
    const findings = join(tmpdir(), `archrad-lint-findings-${Date.now()}.json`);
    try {
      const r = runCli([
        'lint',
        '--no-config',
        '--ir',
        warningsOnly,
        '--metrics-file',
        metrics,
        '--findings-json-out',
        findings,
      ]);
      if (r.status === null) return;
      expect(r.status).toBe(0);
      const m = JSON.parse(readFileSync(metrics, 'utf8')) as { warningCount: number };
      expect(m.warningCount).toBeGreaterThan(0);
      const arr = JSON.parse(readFileSync(findings, 'utf8')) as { code: string }[];
      expect(arr.some((x) => x.code.startsWith('IR-LINT-'))).toBe(true);
    } finally {
      try {
        unlinkSync(metrics);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(findings);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('archrad explain', () => {
  it('prints canonical guidance for a known rule', () => {
    const r = runCli(['explain', 'IR-LINT-DIRECT-DB-ACCESS-002']);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IR-LINT-DIRECT-DB-ACCESS-002');
    expect(r.stdout).toContain('Layer: lint');
    expect(r.stdout).toContain('Fix:');
    expect(r.stdout).toMatch(/Docs: https?:\/\//);
  });

  it('is case-insensitive on the input code', () => {
    const r = runCli(['explain', 'ir-lint-direct-db-access-002']);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IR-LINT-DIRECT-DB-ACCESS-002');
  });

  it('emits JSON with --json', () => {
    const r = runCli(['explain', 'IR-LINT-MISSING-AUTH-010', '--json']);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      code: string;
      layer: string;
      title: string;
      remediation: string;
      docsUrl: string;
    };
    expect(obj.code).toBe('IR-LINT-MISSING-AUTH-010');
    expect(obj.layer).toBe('lint');
    expect(obj.title.length).toBeGreaterThan(0);
    expect(obj.remediation.length).toBeGreaterThan(0);
    expect(obj.docsUrl).toMatch(/^https?:/);
  });

  it('exits 1 with "did you mean" for unknown codes', () => {
    const r = runCli(['explain', 'IR-LINT-MISSING-AUTH-01']); // typo
    if (r.status === null) return;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown rule code');
    expect(r.stderr).toContain('IR-LINT-MISSING-AUTH-010');
  });

  it('--list prints every layer', () => {
    const r = runCli(['explain', '--list']);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('IR structural (IR-STRUCT-*):');
    expect(r.stdout).toContain('Architecture lint (IR-LINT-*):');
    expect(r.stdout).toContain('Drift (DRIFT-*):');
  });

  it('--list --json produces a structured object', () => {
    const r = runCli(['explain', '--list', '--json']);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, { code: string }[]>;
    expect(Array.isArray(obj.structural)).toBe(true);
    expect(Array.isArray(obj.lint)).toBe(true);
    expect(obj.lint.length).toBeGreaterThan(0);
  });

  it('exits 1 when called with no code and no --list', () => {
    const r = runCli(['explain']);
    if (r.status === null) return;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('provide a rule code');
  });
});
