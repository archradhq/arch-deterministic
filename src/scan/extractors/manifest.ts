/**
 * Manifest extractor: package.json / requirements.txt → PartialIR (confidence: low).
 *
 * Maps *driver-level* client libraries to infrastructure edges via {@link NPM_LIB_MAP}
 * / {@link PIP_LIB_MAP}. For each manifest with at least one recognized library it
 * emits: one component (service) node, one infra node per recognized dependency
 * (canonical id — see lib-map), and a component→infra edge.
 *
 * Manifests with no recognized dependency are skipped entirely, so monorepos full
 * of tooling package.json files do not flood the draft with empty service nodes.
 */

import { basename, dirname } from 'node:path';
import type { Extractor, PartialIR } from '../types.js';
import { scanNodeId } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import { NPM_LIB_MAP, PIP_LIB_MAP, type InfraTarget } from './lib-map.js';

/** One recognized dependency: the library name, its infra target, and source line. */
type Hit = { lib: string; target: InfraTarget; line: number };

/** 1-based line of the first occurrence of `needle` in `text`, or 1 if absent. */
function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  if (idx < 0) return 1;
  return text.slice(0, idx).split('\n').length;
}

/** Parse package.json runtime `dependencies` into recognized infra hits. */
function npmHits(text: string): Hit[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object') return [];
  const deps = (json as Record<string, unknown>).dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return [];
  const hits: Hit[] = [];
  for (const lib of Object.keys(deps as Record<string, unknown>)) {
    const target = NPM_LIB_MAP[lib];
    if (target) hits.push({ lib, target, line: lineOf(text, `"${lib}"`) });
  }
  return hits;
}

/** Component name from package.json `name`, else null. */
function npmComponentName(text: string): string | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const name = json.name;
    return typeof name === 'string' && name.trim() ? name : null;
  } catch {
    return null;
  }
}

/** Parse a requirements.txt line into a normalized package name, or null. */
export function parseRequirementLine(line: string): string | null {
  const stripped = line.replace(/#.*$/, '').trim();
  if (!stripped || stripped.startsWith('-')) return null; // blank / option line (-r, --hash, …)
  const m = stripped.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  if (!m) return null;
  return m[1]!.toLowerCase();
}

/** Parse requirements.txt into recognized infra hits. */
function pipHits(text: string): Hit[] {
  const lines = text.split(/\r?\n/);
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = parseRequirementLine(lines[i]!);
    if (!name) continue;
    const target = PIP_LIB_MAP[name];
    if (target) hits.push({ lib: name, target, line: i + 1 });
  }
  return hits;
}

/** Derive a component name for a manifest that has no explicit name field. */
function dirComponentName(relPath: string, root: string): string {
  const dir = dirname(relPath);
  if (dir && dir !== '.' ) return basename(dir);
  return basename(root) || 'app';
}

export const manifestExtractor: Extractor = {
  name: 'manifest',
  defaultConfidence: 'low',
  extract(tree): PartialIR[] {
    const partials: PartialIR[] = [];

    for (const file of tree.files) {
      const base = basename(file.relPath);
      const isNpm = base === 'package.json';
      const isPip = base === 'requirements.txt';
      if (!isNpm && !isPip) continue;

      const text = tree.read(file.relPath);
      if (!text.trim()) continue;

      const hits = isNpm ? npmHits(text) : pipHits(text);
      if (hits.length === 0) continue; // no infra signal → skip this manifest

      const componentName =
        (isNpm ? npmComponentName(text) : null) ?? dirComponentName(file.relPath, tree.root);
      const componentId = scanNodeId('service', componentName);

      const nodes: Record<string, unknown>[] = [];
      const edges: Record<string, unknown>[] = [];
      const seenInfra = new Set<string>();

      // Component node — provenance points at the manifest itself.
      nodes.push(
        withProvenance(
          {
            id: componentId,
            type: 'service',
            name: componentName,
            config: { manifest: base },
          },
          provenanceEntry('manifest', file.relPath, 1, 'low'),
        ),
      );

      for (const hit of hits) {
        const infraId = scanNodeId(hit.target.type, hit.target.name);
        const prov = provenanceEntry('manifest', file.relPath, hit.line, 'low');

        if (!seenInfra.has(infraId)) {
          seenInfra.add(infraId);
          nodes.push(
            withProvenance(
              {
                id: infraId,
                type: hit.target.type,
                name: hit.target.name,
                config: { inferredFromLibrary: hit.lib },
              },
              prov,
            ),
          );
        }

        edges.push(
          withProvenance(
            {
              id: `e_${componentId}_${infraId}`,
              from: componentId,
              to: infraId,
              metadata: {
                relation: hit.target.relation,
                protocol: hit.target.protocol,
                async: hit.target.async,
              },
            },
            prov,
          ),
        );
      }

      partials.push({ extractor: 'manifest', nodes, edges, warnings: [] });
    }

    return partials;
  },
};
