/**
 * Thin deterministic drift check: compare a fresh export from IR to an on-disk tree
 * or to an in-memory file map (Cloud API). No semantic IR↔code analysis — regen vs reality.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runDeterministicExport, type DeterministicExportResult } from './exportPipeline.js';
import { normalizeGoldenHostPort } from './hostPort.js';

export type DriftCode = 'DRIFT-MISSING' | 'DRIFT-MODIFIED' | 'DRIFT-EXTRA' | 'DRIFT-NO-EXPORT';

export type DriftFinding = {
  code: DriftCode;
  path: string;
  message: string;
};

export function normalizeExportFileContent(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * Compare expected export map to an actual map (e.g. from client or built from disk reads).
 */
export function diffExpectedExportAgainstFiles(
  expected: Record<string, string>,
  actual: Record<string, string>,
  options?: { strictExtra?: boolean }
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const expectedKeys = Object.keys(expected).sort();
  for (const rel of expectedKeys) {
    if (!(rel in actual)) {
      findings.push({
        code: 'DRIFT-MISSING',
        path: rel,
        message: `Expected generated file is missing from the comparison set`,
      });
      continue;
    }
    const a = normalizeExportFileContent(actual[rel]!);
    const e = normalizeExportFileContent(expected[rel]!);
    if (a !== e) {
      findings.push({
        code: 'DRIFT-MODIFIED',
        path: rel,
        message: `File content differs from deterministic export for this IR`,
      });
    }
  }
  if (options?.strictExtra) {
    for (const rel of Object.keys(actual).sort()) {
      if (!(rel in expected)) {
        findings.push({
          code: 'DRIFT-EXTRA',
          path: rel,
          message: `File exists in comparison set but is not part of the deterministic export`,
        });
      }
    }
  }
  return findings;
}

async function listRelativeFilesRecursive(rootDir: string, sub = ''): Promise<string[]> {
  const dirPath = sub ? join(rootDir, sub) : rootDir;
  const entries = await readdir(dirPath, { withFileTypes: true });
  const out: string[] = [];
  for (const ent of entries) {
    const piece = sub ? `${sub}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...(await listRelativeFilesRecursive(rootDir, piece)));
    } else {
      out.push(piece.replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * Read all files under rootDir into a flat map (relative POSIX paths).
 */
export async function readDirectoryAsExportMap(rootDir: string): Promise<Record<string, string>> {
  const rels = await listRelativeFilesRecursive(rootDir);
  const map: Record<string, string> = {};
  for (const rel of rels) {
    const full = join(rootDir, ...rel.split('/'));
    map[rel] = await readFile(full, 'utf8');
  }
  return map;
}

export async function diffExpectedExportAgainstDirectory(
  expected: Record<string, string>,
  rootDir: string,
  options?: { strictExtra?: boolean }
): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];
  for (const rel of Object.keys(expected).sort()) {
    const fullPath = join(rootDir, ...rel.split('/'));
    let disk: string;
    try {
      disk = await readFile(fullPath, 'utf8');
    } catch {
      findings.push({
        code: 'DRIFT-MISSING',
        path: rel,
        message: `File missing under output directory`,
      });
      continue;
    }
    if (normalizeExportFileContent(disk) !== normalizeExportFileContent(expected[rel]!)) {
      findings.push({
        code: 'DRIFT-MODIFIED',
        path: rel,
        message: `File differs from deterministic export for this IR`,
      });
    }
  }
  if (options?.strictExtra) {
    const onDisk = await listRelativeFilesRecursive(rootDir);
    for (const rel of onDisk.sort()) {
      if (!(rel in expected)) {
        findings.push({
          code: 'DRIFT-EXTRA',
          path: rel,
          message: `Unexpected file not produced by current deterministic export`,
        });
      }
    }
  }
  return findings;
}

export type ValidateDriftResult = {
  ok: boolean;
  driftFindings: DriftFinding[];
  /** True when --strict-extra and any DRIFT-EXTRA was found */
  extraBlocking: boolean;
  exportResult: DeterministicExportResult;
};

export async function runValidateDrift(
  actualIR: any,
  target: string,
  outDir: string,
  opts: {
    hostPort?: string | number;
    skipIrStructuralValidation?: boolean;
    skipIrLint?: boolean;
    strictExtra?: boolean;
  } = {}
): Promise<ValidateDriftResult> {
  const hostPort = normalizeGoldenHostPort(opts.hostPort ?? process.env.ARCHRAD_HOST_PORT);
  const exportResult = await runDeterministicExport(actualIR, target, {
    hostPort,
    skipIrStructuralValidation: Boolean(opts.skipIrStructuralValidation),
    skipIrLint: Boolean(opts.skipIrLint),
  });

  const { files } = exportResult;
  if (Object.keys(files).length === 0) {
    return {
      ok: false,
      driftFindings: [
        {
          code: 'DRIFT-NO-EXPORT',
          path: '.',
          message: 'No files generated from IR (structural errors or empty graph); cannot compare drift',
        },
      ],
      extraBlocking: false,
      exportResult,
    };
  }

  const driftFindings = await diffExpectedExportAgainstDirectory(files, outDir, {
    strictExtra: Boolean(opts.strictExtra),
  });

  const blocking = driftFindings.filter(
    (f) => f.code === 'DRIFT-MISSING' || f.code === 'DRIFT-MODIFIED' || f.code === 'DRIFT-NO-EXPORT'
  );
  const extra = driftFindings.filter((f) => f.code === 'DRIFT-EXTRA');
  const extraBlocking = Boolean(opts.strictExtra) && extra.length > 0;
  const ok = blocking.length === 0 && !extraBlocking;

  return {
    ok,
    driftFindings,
    extraBlocking,
    exportResult,
  };
}

export type DriftCheckFilesResult = {
  ok: boolean;
  driftFindings: DriftFinding[];
  extraBlocking: boolean;
  exportResult: DeterministicExportResult;
};

/**
 * Cloud / API: compare a fresh deterministic export to a client-supplied file map (e.g. last export or repo snapshot).
 */
export async function runDriftCheckAgainstFiles(
  actualIR: any,
  target: string,
  actualFiles: Record<string, string>,
  opts: {
    hostPort?: string | number;
    skipIrStructuralValidation?: boolean;
    skipIrLint?: boolean;
    strictExtra?: boolean;
  } = {}
): Promise<DriftCheckFilesResult> {
  const hostPort = normalizeGoldenHostPort(opts.hostPort ?? process.env.ARCHRAD_HOST_PORT);
  const exportResult = await runDeterministicExport(actualIR, target, {
    hostPort,
    skipIrStructuralValidation: Boolean(opts.skipIrStructuralValidation),
    skipIrLint: Boolean(opts.skipIrLint),
  });
  const { files } = exportResult;
  if (Object.keys(files).length === 0) {
    return {
      ok: false,
      driftFindings: [
        {
          code: 'DRIFT-NO-EXPORT',
          path: '.',
          message: 'No files generated from IR (structural errors or empty graph); cannot compare drift',
        },
      ],
      extraBlocking: false,
      exportResult,
    };
  }
  const driftFindings = diffExpectedExportAgainstFiles(files, actualFiles, {
    strictExtra: Boolean(opts.strictExtra),
  });
  const blocking = driftFindings.filter(
    (f) => f.code === 'DRIFT-MISSING' || f.code === 'DRIFT-MODIFIED' || f.code === 'DRIFT-NO-EXPORT'
  );
  const extra = driftFindings.filter((f) => f.code === 'DRIFT-EXTRA');
  const extraBlocking = Boolean(opts.strictExtra) && extra.length > 0;
  const ok = blocking.length === 0 && !extraBlocking;
  return { ok, driftFindings, extraBlocking, exportResult };
}
