/**
 * Full deterministic export for Python FastAPI and Node Express (no LLM).
 * Used by the ArchRad server and the `archrad` CLI.
 */

import generatePythonFastAPIFiles from './pythonFastAPI.js';
import generateNodeExpressFiles from './nodeExpress.js';
import { applyFastApiGoldenLayer, applyNodeExpressGoldenLayer } from './golden-bundle.js';
import { validateOpenApiInBundleStructural } from './openapi-structural.js';
import { normalizeGoldenHostPort } from './hostPort.js';
import {
  validateIrStructural,
  hasIrStructuralErrors,
  type IrStructuralFinding,
} from './ir-structural.js';
import { validateIrLint } from './ir-lint.js';

export type DeterministicExportResult = {
  files: Record<string, string>;
  /** Human-readable lines when generated OpenAPI fails **document-shape** checks (not full spec lint) */
  openApiStructuralWarnings: string[];
  /** OSS IR structural findings (errors block codegen unless skipIrStructuralValidation) */
  irStructuralFindings: IrStructuralFinding[];
  /** Deterministic architecture lint (IR-LINT-*); warnings only by default; does not block codegen */
  irLintFindings: IrStructuralFinding[];
};

/**
 * Generate FastAPI or Express project files + golden Docker/Makefile + OpenAPI **document-shape** check.
 */
export async function runDeterministicExport(
  actualIR: any,
  target: string,
  opts: Record<string, any> = {}
): Promise<DeterministicExportResult> {
  const skipIr = Boolean(opts.skipIrStructuralValidation);
  const irStructuralFindings: IrStructuralFinding[] = skipIr ? [] : validateIrStructural(actualIR);
  if (!skipIr && hasIrStructuralErrors(irStructuralFindings)) {
    return { files: {}, openApiStructuralWarnings: [], irStructuralFindings, irLintFindings: [] };
  }

  const irLintFindings: IrStructuralFinding[] =
    skipIr || Boolean(opts.skipIrLint) ? [] : validateIrLint(actualIR);

  const t = String(target || '').toLowerCase();
  let files: Record<string, string> = {};
  const hostPort = normalizeGoldenHostPort(
    opts.hostPort ?? opts.goldenHostPort ?? process.env.ARCHRAD_HOST_PORT
  );
  const goldenOpts = { hostPort };

  if (t === 'python') {
    files = await generatePythonFastAPIFiles(actualIR, opts).catch(() => ({} as Record<string, string>));
    applyFastApiGoldenLayer(files, goldenOpts);
  } else if (t === 'node' || t === 'nodejs') {
    files = await generateNodeExpressFiles(actualIR, opts).catch(() => ({} as Record<string, string>));
    applyNodeExpressGoldenLayer(files, goldenOpts);
  } else {
    throw new Error(
      `runDeterministicExport: unsupported target "${target}". Use "python", "node", or "nodejs".`
    );
  }

  const vr = validateOpenApiInBundleStructural(files);
  const openApiStructuralWarnings: string[] = [];
  if (!vr.ok && vr.path) {
    for (const e of vr.errors) {
      openApiStructuralWarnings.push(`${vr.path}: ${e}`);
    }
  } else if (!vr.ok) {
    openApiStructuralWarnings.push(...vr.errors);
  }

  return { files, openApiStructuralWarnings, irStructuralFindings, irLintFindings };
}
