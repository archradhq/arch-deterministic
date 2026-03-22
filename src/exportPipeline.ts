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
  /**
   * IR-STRUCT-* from `validateIrStructural`, or — when **`skipIrStructuralValidation`** is set — the same
   * codes surfaced by **`validateIrLint`** if the IR cannot be parsed (invalid root, empty graph, etc.).
   * Errors block codegen; this field stays the single source for “graph does not compile.”
   */
  irStructuralFindings: IrStructuralFinding[];
  /** IR-LINT-* heuristics only; does not include IR-STRUCT-* (those live in `irStructuralFindings`). */
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
  const skipLint = Boolean(opts.skipIrLint);

  let irStructuralFindings: IrStructuralFinding[] = skipIr ? [] : validateIrStructural(actualIR);
  if (!skipIr && hasIrStructuralErrors(irStructuralFindings)) {
    return { files: {}, openApiStructuralWarnings: [], irStructuralFindings, irLintFindings: [] };
  }

  let irLintFindings: IrStructuralFinding[] = [];
  if (!skipLint) {
    const lintPass = validateIrLint(actualIR);
    if (skipIr) {
      // Dangerous mode: full structural pass is off, but parse/normalize failures still return IR-STRUCT-* from
      // validateIrLint — fold those into irStructuralFindings so InkByte / CLI consumers block and log like normal.
      const structFromLint = lintPass.filter((f) => f.code.startsWith('IR-STRUCT-'));
      irLintFindings = lintPass.filter((f) => !f.code.startsWith('IR-STRUCT-'));
      irStructuralFindings = structFromLint;
      if (hasIrStructuralErrors(irStructuralFindings)) {
        return { files: {}, openApiStructuralWarnings: [], irStructuralFindings, irLintFindings };
      }
    } else {
      irLintFindings = lintPass;
    }
  }

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
