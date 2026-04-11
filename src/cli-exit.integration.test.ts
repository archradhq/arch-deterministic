/**
 * Spawns built `dist/cli.js` (npm test runs `npm run build` first).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
});
