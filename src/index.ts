/**
 * @archrad/deterministic — structural OpenAPI, golden Docker/Makefile, FastAPI/Express generators (no LLM).
 */

export {
  findOpenApiInBundle,
  parseOpenApiString,
  validateOpenApiStructural,
  serializeOpenApiDoc,
  validateOpenApiInBundleStructural,
} from './openapi-structural.js';

export {
  applyFastApiGoldenLayer,
  applyNodeExpressGoldenLayer,
  patchMainPyPort8080,
  patchExpressIndexPort8080,
  mergePackageJsonScripts,
  type GoldenStack,
  type GoldenLayerOptions,
} from './golden-bundle.js';

export {
  DEFAULT_GOLDEN_HOST_PORT,
  normalizeGoldenHostPort,
  isLocalHostPortFree,
} from './hostPort.js';

export * from './edgeConfigCodeGenerator.js';

export { default as generatePythonFastAPIFiles } from './pythonFastAPI.js';
export { default as generateNodeExpressFiles } from './nodeExpress.js';

export { runDeterministicExport, type DeterministicExportResult } from './exportPipeline.js';
