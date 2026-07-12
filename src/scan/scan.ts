/**
 * `archrad scan` orchestrator.
 *
 * Runs the enabled extractors over a repository, backfills provenance, merges the
 * fragments with the confidence-aware merger, and emits a draft IR marked
 * `metadata.status: "draft"`. Deterministic: same repo in → byte-identical IR out.
 * See docs/SPEC-scan.md.
 */

import { basename, resolve } from 'node:path';
import type { Extractor, ScanOptions, ScanResult } from './types.js';
import { ScanError } from './types.js';
import { buildScanFileTree } from './file-tree.js';
import { ensureProvenance } from './provenance.js';
import { mergeDraftFragments } from './merge-draft.js';
import { composeExtractor } from './extractors/compose.js';
import { openapiExtractor } from './extractors/openapi.js';
import { manifestExtractor } from './extractors/manifest.js';
import { codeExtractor } from './extractors/code.js';

/** All registered extractors, in canonical priority order (highest first). */
export const REGISTERED_EXTRACTORS: Extractor[] = [
  composeExtractor,
  openapiExtractor,
  manifestExtractor,
  codeExtractor,
];

export function registeredExtractorNames(): string[] {
  return REGISTERED_EXTRACTORS.map((e) => e.name);
}

/** Select enabled extractors in canonical order; throws on unknown names. */
function selectExtractors(requested?: string[]): Extractor[] {
  if (!requested || requested.length === 0) return REGISTERED_EXTRACTORS;
  const known = new Map(REGISTERED_EXTRACTORS.map((e) => [e.name, e]));
  const unknown = requested.filter((r) => !known.has(r));
  if (unknown.length > 0) {
    throw new ScanError(
      `unknown extractor(s): ${unknown.join(', ')}. Available: ${registeredExtractorNames().join(', ')}`,
    );
  }
  // Preserve canonical (registered) order regardless of request order for
  // deterministic priority.
  return REGISTERED_EXTRACTORS.filter((e) => requested.includes(e.name));
}

export async function scanCodebase(opts: ScanOptions): Promise<ScanResult> {
  const root = resolve(opts.from);
  const extractors = selectExtractors(opts.extractors);
  const tree = buildScanFileTree(root, opts.exclude ?? []);

  const partials = [];
  const warnings: string[] = [];

  for (const extractor of extractors) {
    const produced = await extractor.extract(tree);
    for (const partial of produced) {
      const annotated = ensureProvenance(partial, extractor.defaultConfidence);
      partials.push(annotated);
      warnings.push(...annotated.warnings);
    }
  }

  const order = extractors.map((e) => e.name);
  const merged = mergeDraftFragments(partials, { priority: order });
  warnings.push(...merged.warnings);

  if (merged.nodes.length === 0) {
    warnings.push(
      `archrad scan: no structural signals found in ${root} (extractors: ${order.join(', ') || 'none'}).`,
    );
  }

  const ir: Record<string, unknown> = {
    graph: {
      metadata: {
        name: basename(root),
        status: 'draft',
        provenance: {
          source: 'scan',
          extractors: order,
          fileCount: tree.files.length,
        },
      },
      nodes: merged.nodes,
      edges: merged.edges,
    },
  };

  return {
    ir,
    extractorsRun: order,
    warnings,
    fileCount: tree.files.length,
  };
}
