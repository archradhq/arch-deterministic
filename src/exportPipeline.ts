/**
 * Full deterministic export for Python FastAPI and Node Express (no LLM).
 * Used by the ArchRad server and the `archrad` CLI.
 */

import generatePythonFastAPIFiles from './pythonFastAPI.js';
import generateNodeExpressFiles from './nodeExpress.js';
import { applyFastApiGoldenLayer, applyNodeExpressGoldenLayer } from './golden-bundle.js';
import { validateOpenApiInBundleStructural } from './openapi-structural.js';

export type DeterministicExportResult = {
  files: Record<string, string>;
  /** Human-readable lines when OpenAPI in bundle fails structural checks */
  openApiStructuralWarnings: string[];
};

/**
 * Generate FastAPI or Express project files + golden Docker/Makefile + structural OpenAPI check.
 */
export async function runDeterministicExport(
  actualIR: any,
  target: string,
  opts: Record<string, any> = {}
): Promise<DeterministicExportResult> {
  const t = String(target || '').toLowerCase();
  let files: Record<string, string> = {};

  if (t === 'python') {
    files = await generatePythonFastAPIFiles(actualIR, opts).catch(() => ({} as Record<string, string>));
    applyFastApiGoldenLayer(files);
  } else if (t === 'node' || t === 'nodejs') {
    files = await generateNodeExpressFiles(actualIR, opts).catch(() => ({} as Record<string, string>));
    const det = await generateNodeExpressFiles(actualIR, opts).catch(() => ({} as Record<string, string>));
    if (det['openapi.yaml']) {
      files['openapi.yaml'] = det['openapi.yaml'];
    }
    if (!files['app/index.js'] && det['app/index.js']) {
      files['app/index.js'] = det['app/index.js'];
    }
    if (!files['package.json'] && det['package.json']) {
      files['package.json'] = det['package.json'];
    }
    applyNodeExpressGoldenLayer(files);
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

  return { files, openApiStructuralWarnings };
}
