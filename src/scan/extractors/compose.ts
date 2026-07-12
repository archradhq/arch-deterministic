/**
 * Topology extractor: Docker Compose → PartialIR (confidence: high).
 *
 * Reuses the tested `dockerComposeToCanonicalIr()` converter from the `init`
 * command path, then (a) canonicalizes node ids via {@link canonicalizeIds} so
 * other extractors can agree on shared components, and (b) attaches per-service
 * provenance with the real line number of the service key.
 */

import { basename } from 'node:path';
import type { Extractor, PartialIR } from '../types.js';
import { canonicalizeIds } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import {
  dockerComposeToCanonicalIr,
  DockerComposeInitError,
} from '../../init/docker-compose.js';

const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i;

/** True for `docker-compose.yml`, `compose.yaml`, `docker-compose.prod.yml`, etc. */
export function isComposeFile(relPath: string): boolean {
  return COMPOSE_FILE.test(basename(relPath));
}

/**
 * Map each service name to the 1-based line of its key in the compose file.
 * Best-effort: falls back to line 1 for names not located.
 */
export function serviceLineIndex(text: string, names: Set<string>): Map<string, number> {
  const lines = text.split(/\r?\n/);
  const map = new Map<string, number>();
  let inServices = false;
  let baseIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (!inServices) {
      if (/^\s*services\s*:\s*$/.test(line)) {
        inServices = true;
        baseIndent = -1;
      }
      continue;
    }
    const km = line.match(/^(\s*)([A-Za-z0-9._-]+)\s*:/);
    if (!km) continue;
    const indent = km[1]!.length;
    const key = km[2]!;
    if (indent === 0) {
      // A new top-level block ends the services mapping.
      inServices = false;
      continue;
    }
    if (baseIndent === -1) baseIndent = indent;
    if (indent === baseIndent && names.has(key) && !map.has(key)) {
      map.set(key, i + 1);
    }
  }
  return map;
}

export const composeExtractor: Extractor = {
  name: 'compose',
  defaultConfidence: 'high',
  extract(tree): PartialIR[] {
    const partials: PartialIR[] = [];

    for (const file of tree.files) {
      if (!isComposeFile(file.relPath)) continue;
      const text = tree.read(file.relPath);
      if (!text.trim()) continue;

      let ir: Record<string, unknown>;
      const warnings: string[] = [];
      try {
        const result = dockerComposeToCanonicalIr(text, { fileLabel: file.relPath });
        ir = result.ir;
        for (const w of result.report.warnings) {
          warnings.push(`${file.relPath}: ${w}`);
        }
      } catch (e) {
        warnings.push(
          `${file.relPath}: ${
            e instanceof DockerComposeInitError ? e.message : String(e)
          } — skipped`,
        );
        partials.push({ extractor: 'compose', nodes: [], edges: [], warnings });
        continue;
      }

      const graph = (ir.graph ?? ir) as Record<string, unknown>;
      const rawNodes = (Array.isArray(graph.nodes) ? graph.nodes : []) as Record<string, unknown>[];
      const rawEdges = (Array.isArray(graph.edges) ? graph.edges : []) as Record<string, unknown>[];

      const names = new Set(
        rawNodes.map((n) => (typeof n.name === 'string' ? n.name : '')).filter(Boolean),
      );
      const lineByName = serviceLineIndex(text, names);
      const nameById = new Map<string, string>();
      for (const n of rawNodes) {
        if (typeof n.id === 'string' && typeof n.name === 'string') nameById.set(n.id, n.name);
      }

      // Attach provenance BEFORE canonicalizing so provenance survives the id
      // remap (canonicalizeIds preserves `config`).
      const nodes = rawNodes.map((n) => {
        const name = typeof n.name === 'string' ? n.name : '';
        const line = lineByName.get(name) ?? 1;
        return withProvenance(n, provenanceEntry('compose', file.relPath, line, 'high'));
      });
      const edges = rawEdges.map((e) => {
        const fromName = typeof e.from === 'string' ? nameById.get(e.from) : undefined;
        const line = fromName ? lineByName.get(fromName) ?? 1 : 1;
        return withProvenance(e, provenanceEntry('compose', file.relPath, line, 'high'));
      });

      const canon = canonicalizeIds(nodes, edges);
      partials.push({
        extractor: 'compose',
        nodes: canon.nodes,
        edges: canon.edges,
        warnings,
      });
    }

    return partials;
  },
};
