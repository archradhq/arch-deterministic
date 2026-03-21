/**
 * Normalized graph context for architecture lint rules (visitor pattern).
 */

import { normalizeIrGraph } from './ir-structural.js';
import { materializeNormalizedGraph } from './ir-normalize.js';

export type ParsedLintGraph = {
  nodeById: Map<string, Record<string, unknown>>;
  edges: unknown[];
  adj: Map<string, string[]>;
  outDegree: Map<string, number>;
};

export function edgeEndpoints(e: Record<string, unknown>): { from: string; to: string } {
  const from = String(e.from ?? e.source ?? '').trim();
  const to = String(e.to ?? e.target ?? '').trim();
  return { from, to };
}

export function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? n.kind ?? '').toLowerCase();
}

export function isDbLikeType(t: string): boolean {
  if (!t) return false;
  return (
    /\b(db|database|datastore)\b/.test(t) ||
    /postgres|mongodb|mysql|sqlite|redis|cassandra|dynamo|sql|nosql|warehouse|s3/.test(t)
  );
}

export function isHttpLikeType(t: string): boolean {
  return t === 'http' || t === 'https' || t === 'rest' || t === 'api';
}

export function looksLikeHealthUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    /(^|\/)health(z)?(\/|$|\?)/.test(u) ||
    /(^|\/)live(\/|$|\?)/.test(u) ||
    /(^|\/)ready(\/|$|\?)/.test(u)
  );
}

/**
 * Build a parsed graph for lint visitors. Returns null if IR cannot be normalized or has no nodes.
 */
export function buildParsedLintGraph(ir: unknown): ParsedLintGraph | null {
  const norm = normalizeIrGraph(ir);
  if ('findings' in norm) return null;

  const graph = norm.graph;
  const nodesRaw = graph.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) return null;

  const { normalized } = materializeNormalizedGraph(graph);

  const nodeById = new Map<string, Record<string, unknown>>();
  for (const n of normalized.nodes) {
    if (!n.id) continue;
    nodeById.set(n.id, {
      id: n.id,
      type: n.type,
      kind: n.type,
      name: n.name,
      config: n.config,
      schema: n.schema,
    });
  }

  const edges: unknown[] = normalized.edges as unknown[];
  const adj = new Map<string, string[]>();
  const outDegree = new Map<string, number>();

  for (const id of nodeById.keys()) {
    adj.set(id, []);
    outDegree.set(id, 0);
  }

  for (const ne of normalized.edges) {
    const { from, to } = ne;
    if (!from || !to || !nodeById.has(from) || !nodeById.has(to)) continue;
    adj.get(from)!.push(to);
    outDegree.set(from, (outDegree.get(from) || 0) + 1);
  }

  return { nodeById, edges, adj, outDegree };
}
