/**
 * Spawns built `dist/cli.js` (npm test runs `npm run build` first).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  if (!existsSync(cliJs)) return { status: null, stdout: '', stderr: '' };
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('archrad reconstruct CLI', () => {
  it('writes reconstructed IR with --dry-run and reports artifacts with --verbose', () => {
    const root = mkdtempSync(join(tmpdir(), 'archrad-reconstruct-cli-'));
    try {
      writeFileSync(join(root, 'package.json'), '{ "name": "cli-api" }\n', 'utf8');
      writeFileSync(
        join(root, 'app.js'),
        [
          "const express = require('express');",
          'const app = express();',
          "app.get('/items', (_req, res) => res.json([]));",
          "app.get('/healthz', (_req, res) => res.json({ ok: true }));",
          'app.listen(3000);',
        ].join('\n'),
        'utf8',
      );

      const r = runCli(['reconstruct', '--from', root, '--dry-run', '--verbose', '--language', 'nodejs']);
      expect(r.status).not.toBeNull();
      expect(r.status).toBe(0);

      const parsed = JSON.parse(r.stdout) as {
        graph?: { nodes?: { config?: { url?: string } }[] };
      };
      expect(parsed.graph?.nodes?.length).toBeGreaterThan(0);
      expect(parsed.graph?.nodes?.[0]?.config?.url).toBe('/healthz');
      expect(r.stderr).toMatch(/GET \/items/);
      expect(r.stderr).toMatch(/GET \/healthz/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
