/**
 * Interface extractor: OpenAPI / Swagger → PartialIR (confidence: medium).
 *
 * Reuses the tested `openApiStringToCanonicalIr()` engine from the `ingest openapi`
 * command path. Unlike the compose extractor, node ids are left as the engine
 * produced them (route-based, already unique) — HTTP operation nodes are leaf
 * endpoints that won't collide with other extractors' components, so there is no
 * canonical-id remap to do. Each operation node just gets provenance + confidence.
 */

import { basename } from 'node:path';
import type { Extractor, PartialIR } from '../types.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import { scanNodeId } from '../node-id.js';
import { openApiStringToCanonicalIr, OpenApiIngestError } from '../../openapi-to-ir.js';

/** Filename looks like an OpenAPI/Swagger spec (parser validates the content). */
const SPEC_FILE = /(?:^|[.\-_])(?:openapi|swagger)(?:[.\-_].*)?\.(?:ya?ml|json)$/i;

export function isOpenApiFile(relPath: string): boolean {
  return SPEC_FILE.test(basename(relPath));
}

export const openapiExtractor: Extractor = {
  name: 'openapi',
  defaultConfidence: 'medium',
  extract(tree): PartialIR[] {
    const partials: PartialIR[] = [];

    for (const file of tree.files) {
      if (!isOpenApiFile(file.relPath)) continue;
      const text = tree.read(file.relPath);
      if (!text.trim()) continue;

      let ir: Record<string, unknown>;
      try {
        ir = openApiStringToCanonicalIr(text);
      } catch (e) {
        // Filename matched but content isn't a valid spec — skip with a note,
        // never fail the whole scan.
        partials.push({
          extractor: 'openapi',
          nodes: [],
          edges: [],
          warnings: [
            `${file.relPath}: ${
              e instanceof OpenApiIngestError ? e.message : String(e)
            } — not a valid OpenAPI spec, skipped`,
          ],
        });
        continue;
      }

      const graph = (ir.graph ?? ir) as Record<string, unknown>;
      const rawNodes = (Array.isArray(graph.nodes) ? graph.nodes : []) as Record<string, unknown>[];
      const rawEdges = (Array.isArray(graph.edges) ? graph.edges : []) as Record<string, unknown>[];

      const prov = () => provenanceEntry('openapi', file.relPath, 1, 'medium');

      // A spec yields one node per OPERATION. Alone they are a bag of
      // unconnected routes: each trips IR-LINT-ISOLATED-NODE-005, and the count
      // scales with the spec — a 200-endpoint API produced 200 findings that said
      // nothing about the architecture.
      //
      // The API serving those routes is the missing component. Emitting it and
      // routing edges to each operation restates what the document already says
      // (`info.title` fronting its own paths); it infers nothing about the system.
      const meta = (graph.metadata ?? {}) as Record<string, unknown>;
      const apiName = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : 'api';
      const apiId = scanNodeId('gateway', apiName);
      const operationIds = rawNodes
        .map((n) => (typeof n.id === 'string' ? n.id : ''))
        .filter((id): id is string => id.length > 0);

      const apiNodes = operationIds.length
        ? [
            withProvenance(
              { id: apiId, type: 'gateway', name: apiName, config: { openapi: { spec: file.relPath } } },
              prov(),
            ),
          ]
        : [];
      const routeEdges = operationIds.map((to) =>
        withProvenance(
          { id: `e_${apiId}_${to}`, from: apiId, to, metadata: { relation: 'routes', protocol: 'http', async: false } },
          prov(),
        ),
      );

      partials.push({
        extractor: 'openapi',
        nodes: [...apiNodes, ...rawNodes.map((n) => withProvenance(n, prov()))],
        edges: [...rawEdges.map((e) => withProvenance(e, prov())), ...routeEdges],
        warnings: [],
      });
    }

    return partials;
  },
};
