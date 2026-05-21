/**
 * End-to-end verification of PR 9:
 *   - `archrad --version` reads the real package.json version.
 *   - `archrad policies-sha256` generates a manifest.
 *   - `archrad validate --policies-require-signed` enforces signing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');
const pkgVersion = (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
  version: string;
}).version;
const warningsOnly = join(pkgRoot, 'fixtures', 'ecommerce-with-warnings.json');

const VALID_POLICY = `apiVersion: archrad/v1
kind: PolicyPack
metadata:
  name: demo
rules:
  - id: DEMO-RULE-001
    severity: warning
    message: demo
    match:
      node:
        type: service
`;

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (!existsSync(cliJs)) return { status: null, stdout: '', stderr: '' };
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('archrad --version', () => {
  it('reports the package.json version (not a stale hardcoded literal)', () => {
    const r = runCli(['--version']);
    if (r.status === null) return;
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkgVersion);
  });
});

describe('archrad policies-sha256', () => {
  it('writes a manifest file with one sha256 line per policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archrad-e2e-sign-'));
    try {
      writeFileSync(join(dir, 'demo.yaml'), VALID_POLICY, 'utf8');
      const r = runCli(['policies-sha256', '--dir', dir]);
      if (r.status === null) return;
      expect(r.status).toBe(0);
      const manifestPath = join(dir, 'archrad-policy-pack.sha256');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = readFileSync(manifestPath, 'utf8');
      expect(manifest).toMatch(/^[a-f0-9]{64}  demo\.yaml$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams manifest to stdout when --out -', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archrad-e2e-sign-'));
    try {
      writeFileSync(join(dir, 'demo.yaml'), VALID_POLICY, 'utf8');
      const r = runCli(['policies-sha256', '--dir', dir, '--out', '-']);
      if (r.status === null) return;
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^[a-f0-9]{64}  demo\.yaml$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with a clear message on an empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archrad-e2e-sign-'));
    try {
      const r = runCli(['policies-sha256', '--dir', dir]);
      if (r.status === null) return;
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no policy files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--policies-require-signed (validate + lint)', () => {
  it('fails validate when manifest missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archrad-e2e-sign-'));
    try {
      writeFileSync(join(dir, 'demo.yaml'), VALID_POLICY, 'utf8');
      const r = runCli([
        'validate',
        '--no-config',
        '--ir',
        warningsOnly,
        '--policies',
        dir,
        '--policies-require-signed',
      ]);
      if (r.status === null) return;
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/manifest.*not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes validate when manifest is valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archrad-e2e-sign-'));
    try {
      writeFileSync(join(dir, 'demo.yaml'), VALID_POLICY, 'utf8');
      // Generate the manifest via the CLI itself — this closes the loop
      // between `policies-sha256` and `--policies-require-signed`.
      const gen = runCli(['policies-sha256', '--dir', dir]);
      if (gen.status === null) return;
      expect(gen.status).toBe(0);

      const r = runCli([
        'validate',
        '--no-config',
        '--ir',
        warningsOnly,
        '--policies',
        dir,
        '--policies-require-signed',
      ]);
      if (r.status === null) return;
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/policy pack verified \(sha256\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('fails validate when a policy file is tampered after manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archrad-e2e-sign-'));
    try {
      writeFileSync(join(dir, 'demo.yaml'), VALID_POLICY, 'utf8');
      runCli(['policies-sha256', '--dir', dir]);
      writeFileSync(join(dir, 'demo.yaml'), `${VALID_POLICY}\n# tampered\n`, 'utf8');

      const r = runCli([
        'validate',
        '--no-config',
        '--ir',
        warningsOnly,
        '--policies',
        dir,
        '--policies-require-signed',
      ]);
      if (r.status === null) return;
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/sha256 mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('fails lint when --cosign-pubkey set but no .sig file present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archrad-e2e-sign-'));
    try {
      writeFileSync(join(dir, 'demo.yaml'), VALID_POLICY, 'utf8');
      runCli(['policies-sha256', '--dir', dir]);
      const fakeKey = join(dir, 'fake.pub');
      writeFileSync(fakeKey, '-- not a real key --', 'utf8');

      const r = runCli([
        'lint',
        '--no-config',
        '--ir',
        warningsOnly,
        '--policies',
        dir,
        '--cosign-pubkey',
        fakeKey,
      ]);
      if (r.status === null) return;
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/\.sig.*not found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
