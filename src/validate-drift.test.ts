import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  diffExpectedExportAgainstFiles,
  runValidateDrift,
  runDriftCheckAgainstFiles,
  normalizeExportFileContent,
} from './validate-drift.js';
import { runDeterministicExport } from './exportPipeline.js';

const minimalIr = {
  graph: {
    metadata: { name: 'drift-test' },
    nodes: [{ id: 'a', type: 'http', config: { url: '/x', method: 'GET' } }],
    edges: [],
  },
};

async function writeExportTree(base: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(base, ...rel.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
}

describe('validate-drift', () => {
  it('diffExpectedExportAgainstFiles returns empty when identical', () => {
    const m = { 'a.txt': 'hello\n', 'b/c.txt': 'x' };
    expect(diffExpectedExportAgainstFiles(m, { ...m })).toHaveLength(0);
  });

  it('diffExpectedExportAgainstFiles flags missing and modified', () => {
    const exp = { 'f.py': 'a\nb\n' };
    const act = { 'f.py': 'a\nc\n' };
    const d = diffExpectedExportAgainstFiles(exp, act);
    expect(d.some((x) => x.code === 'DRIFT-MODIFIED')).toBe(true);
    const d2 = diffExpectedExportAgainstFiles(exp, {});
    expect(d2.some((x) => x.code === 'DRIFT-MISSING')).toBe(true);
  });

  it('diffExpectedExportAgainstFiles strictExtra flags unknown files', () => {
    const exp = { 'a.txt': '1' };
    const act = { 'a.txt': '1', 'extra.txt': 'z' };
    const d = diffExpectedExportAgainstFiles(exp, act, { strictExtra: true });
    expect(d.some((x) => x.code === 'DRIFT-EXTRA')).toBe(true);
  });

  it('normalizeExportFileContent treats CRLF as LF', () => {
    expect(normalizeExportFileContent('a\r\nb')).toBe('a\nb');
  });

  it('runValidateDrift passes when directory matches fresh export', async () => {
    const { files } = await runDeterministicExport(minimalIr, 'python', { skipIrLint: true });
    const dir = await mkdtemp(join(tmpdir(), 'archrad-drift-'));
    try {
      await writeExportTree(dir, files);
      const r = await runValidateDrift(minimalIr, 'python', dir, { skipIrLint: true });
      expect(r.ok).toBe(true);
      expect(r.driftFindings).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runValidateDrift fails when main.py is edited', async () => {
    const { files } = await runDeterministicExport(minimalIr, 'python', { skipIrLint: true });
    const dir = await mkdtemp(join(tmpdir(), 'archrad-drift-'));
    try {
      await writeExportTree(dir, files);
      const mainPath = join(dir, 'app', 'main.py');
      const cur = await readFile(mainPath, 'utf8');
      await writeFile(mainPath, `${cur}\n# drift\n`, 'utf8');
      const r = await runValidateDrift(minimalIr, 'python', dir, { skipIrLint: true });
      expect(r.ok).toBe(false);
      expect(r.driftFindings.some((x) => x.code === 'DRIFT-MODIFIED')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runDriftCheckAgainstFiles matches in-memory map', async () => {
    const { files } = await runDeterministicExport(minimalIr, 'python', { skipIrLint: true });
    const r = await runDriftCheckAgainstFiles(minimalIr, 'python', files, { skipIrLint: true });
    expect(r.ok).toBe(true);
  });
});
