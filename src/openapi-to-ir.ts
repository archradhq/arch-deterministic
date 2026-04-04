/**
 * OpenAPI 3.x → canonical blueprint IR (structural HTTP surface only).
 * OSS + product share this: CLI `archrad ingest openapi`, Cloud merge-into-graph, CI regenerate.
 * This is not semantic architecture truth — only operations under `paths` become `http` nodes.
 */

import { parseOpenApiString, validateOpenApiStructural } from './openapi-structural.js';

export class OpenApiIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiIngestError';
  }
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

function normalizeOpenApiPath(pathKey: string): string {
  const s = String(pathKey).trim() || '/';
  return s.startsWith('/') ? s : `/${s}`;
}

function safeServiceName(title: string): string {
  const t = String(title || 'openapi-service')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return t.slice(0, 63) || 'openapi-service';
}

function safeNodeId(path: string, method: string): string {
  const slug = `${method}_${path}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  return `openapi_${slug || 'route'}`.slice(0, 80);
}

export type OpenApiHttpNode = {
  id: string;
  type: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
};

/**
 * List HTTP operations as IR `http` nodes (ids unique within this batch; caller dedupes against a graph).
 */
export function openApiDocumentToHttpNodes(doc: Record<string, unknown>): OpenApiHttpNode[] {
  const paths = doc.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return [];
  }

  const globalSecurity = doc.security;
  const nodes: OpenApiHttpNode[] = [];
  const usedIds = new Set<string>();

  for (const [pathKey, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) continue;
    const url = normalizeOpenApiPath(pathKey);

    for (const m of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[m];
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;

      const opRec = op as Record<string, unknown>;
      const summary =
        typeof opRec.summary === 'string'
          ? String(opRec.summary)
          : typeof opRec.operationId === 'string'
            ? String(opRec.operationId)
            : '';

      let id = safeNodeId(url, m);
      while (usedIds.has(id)) {
        id = `${id}_${Math.random().toString(36).slice(2, 7)}`;
      }
      usedIds.add(id);

      const operationId = opRec.operationId;
      const securityConfig = resolveOperationSecurity(opRec, globalSecurity);

      nodes.push({
        id,
        type: 'http',
        kind: 'http',
        name: summary || `${m.toUpperCase()} ${url}`,
        config: {
          url,
          route: url,
          method: m.toUpperCase(),
          openApiIngest: true,
          ...(typeof operationId === 'string' && operationId.trim() ? { operationId } : {}),
          ...securityConfig,
        },
      });
    }
  }

  return nodes;
}

/**
 * Extract unique scheme names from a security requirement array.
 * Each entry is an object whose keys are scheme names, e.g. `[{ "BearerAuth": [] }]`.
 * Returns sorted names for determinism.
 */
function extractSecuritySchemeNames(securityArray: unknown): string[] {
  if (!Array.isArray(securityArray)) return [];
  const names = new Set<string>();
  for (const req of securityArray) {
    if (req && typeof req === 'object' && !Array.isArray(req)) {
      for (const name of Object.keys(req as Record<string, unknown>)) {
        if (name.trim()) names.add(name.trim());
      }
    }
  }
  return [...names].sort();
}

/**
 * Resolve effective security for a single operation, respecting OpenAPI 3.x precedence:
 * operation-level `security` overrides the global spec-level `security`.
 * An explicit empty array `[]` means intentionally no auth (public endpoint).
 *
 * Returns:
 *   - `{ authRequired: false }` when the effective security is explicitly empty `[]`
 *   - `{ security: string[] }` when scheme names are present
 *   - `{}` when no security is declared at either level
 */
function resolveOperationSecurity(
  op: Record<string, unknown>,
  globalSecurity: unknown,
): Record<string, unknown> {
  const hasOperationSecurity = 'security' in op;
  const effective = hasOperationSecurity ? op.security : globalSecurity;

  if (!Array.isArray(effective)) return {};

  // Explicit empty array → intentionally public
  if (effective.length === 0) return { authRequired: false };

  const names = extractSecuritySchemeNames(effective);
  return names.length > 0 ? { security: names } : {};
}

function provenanceBlock(doc: Record<string, unknown>) {
  const ver = doc.openapi != null ? String(doc.openapi) : doc.swagger != null ? String(doc.swagger) : '';
  const info = (doc.info && typeof doc.info === 'object' ? doc.info : {}) as Record<string, unknown>;
  return {
    source: 'openapi-ingest',
    openapiVersion: ver,
    specTitle: String(info.title ?? ''),
    specVersion: String(info.version ?? ''),
  };
}

/**
 * Full canonical IR wrapper: `{ graph: { metadata, nodes, edges }, metadata? }` — same shape as `yaml-to-ir` / `minimal-graph.json`.
 */
export function openApiDocumentToCanonicalIr(doc: Record<string, unknown>): Record<string, unknown> {
  const v = validateOpenApiStructural(doc);
  if (!v.ok) {
    throw new OpenApiIngestError(`Invalid OpenAPI document shape: ${v.errors.join('; ')}`);
  }

  const info = (doc.info && typeof doc.info === 'object' ? doc.info : {}) as Record<string, unknown>;
  const title = String(info.title ?? 'OpenAPI service');
  const description = String(info.description ?? '').trim();
  const serviceName = safeServiceName(title);

  const nodes = openApiDocumentToHttpNodes(doc);
  if (nodes.length === 0) {
    throw new OpenApiIngestError(
      'No operations found under `paths` (supported methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD).'
    );
  }

  const prov = provenanceBlock(doc);

  return {
    metadata: { name: serviceName },
    graph: {
      metadata: {
        name: serviceName,
        ...(description ? { description } : {}),
        provenance: prov,
      },
      nodes,
      edges: [],
    },
  };
}

export function openApiStringToCanonicalIr(content: string): Record<string, unknown> {
  const parsed = parseOpenApiString(content);
  if (!parsed) {
    throw new OpenApiIngestError('Could not parse OpenAPI as JSON or YAML');
  }
  return openApiDocumentToCanonicalIr(parsed.doc);
}

export function openApiUnknownToCanonicalIr(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    return openApiStringToCanonicalIr(input);
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return openApiDocumentToCanonicalIr(input as Record<string, unknown>);
  }
  throw new OpenApiIngestError('OpenAPI input must be a JSON/YAML string or a parsed object');
}
