/**
 * Spawns built `dist/cli.js` (npm test runs `npm run build` first).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');
const invalidStructural = join(pkgRoot, 'fixtures', 'invalid-edge-unknown-node.json');
const warningsOnly = join(pkgRoot, 'fixtures', 'ecommerce-with-warnings.json');

function runValidate(args: string[]): number | null {
  if (!existsSync(cliJs)) return null;
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status;
}

describe('archrad validate exit codes', () => {
  it('exits 1 when IR structural errors are present', () => {
    const code = runValidate(['validate', '--ir', invalidStructural]);
    expect(code).not.toBeNull();
    expect(code).toBe(1);
  });

  it('exits 0 when only lint warnings (no errors)', () => {
    const code = runValidate(['validate', '--ir', warningsOnly]);
    expect(code).not.toBeNull();
    expect(code).toBe(0);
  });

  it('exits 1 with --fail-on-warning when warnings exist', () => {
    const code = runValidate(['validate', '--ir', warningsOnly, '--fail-on-warning']);
    expect(code).not.toBeNull();
    expect(code).toBe(1);
  });

  it('exits 1 when warnings exceed --max-warnings', () => {
    const code = runValidate(['validate', '--ir', warningsOnly, '--max-warnings', '0']);
    expect(code).not.toBeNull();
    expect(code).toBe(1);
  });

  it('exits 0 with --fail-on never despite warnings', () => {
    const code = runValidate(['validate', '--ir', warningsOnly, '--fail-on', 'never']);
    expect(code).not.toBeNull();
    expect(code).toBe(0);
  });

  it('exits 1 with --fail-on warning when warnings exist', () => {
    const code = runValidate(['validate', '--ir', warningsOnly, '--fail-on', 'warning']);
    expect(code).not.toBeNull();
    expect(code).toBe(1);
  });

  it('writes --metrics-file and --report', () => {
    const m = join(tmpdir(), `archrad-metrics-${Date.now()}.json`);
    const h = join(tmpdir(), `archrad-report-${Date.now()}.html`);
    try {
      const r = spawnSync(process.execPath, [cliJs, 'validate', '--ir', warningsOnly, '--metrics-file', m, '--report', h], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(r.status).toBe(0);
      const metrics = JSON.parse(readFileSync(m, 'utf8')) as { findingsCount: number; warningCount: number };
      expect(metrics.findingsCount).toBeGreaterThan(0);
      expect(metrics.warningCount).toBeGreaterThan(0);
      expect(readFileSync(h, 'utf8')).toContain('IR-LINT');
    } finally {
      try {
        unlinkSync(m);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(h);
      } catch {
        /* ignore */
      }
    }
  });

  it('writes --findings-json-out array', () => {
    const j = join(tmpdir(), `archrad-findings-${Date.now()}.json`);
    try {
      const r = spawnSync(
        process.execPath,
        [cliJs, 'validate', '--ir', warningsOnly, '--fail-on', 'never', '--findings-json-out', j],
        { encoding: 'utf8', windowsHide: true }
      );
      expect(r.status).toBe(0);
      const arr = JSON.parse(readFileSync(j, 'utf8')) as { code: string }[];
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.some((x) => x.code?.startsWith('IR-LINT'))).toBe(true);
    } finally {
      try {
        unlinkSync(j);
      } catch {
        /* ignore */
      }
    }
  });

  it('--impl-drift-fail-on is independent of main --fail-on when --codebase warns', () => {
    const codebase = mkdtempSync(join(tmpdir(), 'archrad-impl-drift-exit-'));
    const irPath = join(codebase, 'ir.json');
    writeFileSync(irPath, JSON.stringify({ graph: { nodes: [{ id: 'a', type: 'service', name: 'S' }], edges: [] } }), 'utf8');
    writeFileSync(join(codebase, 'package.json'), '{ "name": "svc" }\n', 'utf8');
    writeFileSync(
      join(codebase, 'app.js'),
      "const axios = require('axios');\naxios.get('http://downstream/example');\n",
      'utf8'
    );
    try {
      const status = runValidate([
        'validate',
        '--ir',
        irPath,
        '--skip-lint',
        '--codebase',
        codebase,
        '--fail-on',
        'warning',
        '--impl-drift-fail-on',
        'never',
      ]);
      expect(status).not.toBeNull();
      expect(status).toBe(0);
    } finally {
      try {
        unlinkSync(join(codebase, 'app.js'));
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(join(codebase, 'package.json'));
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(irPath);
      } catch {
        /* ignore */
      }
      try {
        rmSync(codebase, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
