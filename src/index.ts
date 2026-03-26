/**
 * @archrad/deterministic — IR structural validation, FastAPI/Express generators, OpenAPI **document-shape**
 * checks, golden Docker/Makefile (no LLM). Semantic architecture / compliance lives in ArchRad Cloud.
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

export {
  diffExpectedExportAgainstFiles,
  diffExpectedExportAgainstDirectory,
  readDirectoryAsExportMap,
  runValidateDrift,
  runDriftCheckAgainstFiles,
  normalizeExportFileContent,
  type DriftFinding,
  type DriftCode,
  type ValidateDriftResult,
  type DriftCheckFilesResult,
} from './validate-drift.js';

export {
  normalizeIrGraph,
  validateIrStructural,
  hasIrStructuralErrors,
  type IrStructuralFinding,
  type IrStructuralSeverity,
  type IrFindingLayer,
} from './ir-structural.js';

export {
  materializeNormalizedGraph,
  normalizeNodeSlot,
  normalizeEdgeSlot,
  type NormalizedGraph,
  type NormalizedNode,
  type NormalizedEdge,
  type MaterializeResult,
} from './ir-normalize.js';

export { validateIrLint } from './ir-lint.js';
export { runArchitectureLinting, LINT_RULE_REGISTRY } from './lint-rules.js';
export {
  buildParsedLintGraph,
  isParsedLintGraph,
  type ParsedLintGraph,
  type BuildParsedLintGraphResult,
} from './lint-graph.js';

export { isHttpLikeType, isDbLikeType, isQueueLikeNodeType } from './graphPredicates.js';

export { sortFindings, shouldFailFromFindings, type ValidationExitPolicy } from './cli-findings.js';

export {
  parseYamlToCanonicalIr,
  canonicalIrToJsonString,
  YamlGraphParseError,
} from './yamlToIr.js';

export {
  openApiDocumentToHttpNodes,
  openApiDocumentToCanonicalIr,
  openApiStringToCanonicalIr,
  openApiUnknownToCanonicalIr,
  OpenApiIngestError,
  type OpenApiHttpNode,
} from './openapi-to-ir.js';
