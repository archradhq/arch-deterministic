/**
 * Normalized graph context for architecture lint rules (visitor pattern).
 */

import type { IrStructuralFinding } from './ir-structural.js';
import { normalizeIrGraph } from './ir-structural.js';
import { materializeNormalizedGraph } from './ir-normalize.js';
import { isQueueLikeNodeType } from './graphPredicates.js';

/** Re-export shared predicates (structural + lint use the same HTTP/datastore semantics). */
export { isHttpLikeType, isDbLikeType, isQueueLikeNodeType } from './graphPredicates.js';

export type ParsedLintGraph = {
  nodeById: Map<string, Record<string, unknown>>;
  edges: unknown[];
  adj: Map<string, string[]>;
  outDegree: Map<string, number>;
  /** In-degree per node id (built once; use instead of recomputing per rule). */
  inDegree: Map<string, number>;
};

export type BuildParsedLintGraphResult = ParsedLintGraph | { findings: IrStructuralFinding[] };

export function edgeEndpoints(e: Record<string, unknown>): { from: string; to: string } {
  const from = String(e.from ?? e.source ?? '').trim();
  const to = String(e.to ?? e.target ?? '').trim();
  return { from, to };
}

export function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? n.kind ?? '').toLowerCase();
}

export function looksLikeHealthUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    /(^|\/)health(z)?(\/|$|\?)/.test(u) ||
    /(^|\/)healthcheck(\/|$|\?)/.test(u) ||
    /(^|\/)ping(\/|$|\?)/.test(u) ||
    /(^|\/)status(\/|$|\?)/.test(u) ||
    /(^|\/)alive(\/|$|\?)/.test(u) ||
    /(^|\/)live(\/|$|\?)/.test(u) ||
    /(^|\/)ready(\/|$|\?)/.test(u)
  );
}

/**
 * When true, the edge is treated as **async** for IR-LINT-SYNC-CHAIN-001 (excluded from sync depth).
 * Convention: `edge.config` / `edge.metadata` may set `async: true`, `protocol: async|message|queue|event`, or channel-like `kind`.
 * Top-level `edge.kind` is merged into `metadata` during normalization; raw edges still pass `rec.kind` here.
 * If `graph` is provided, edges **to** queue/topic-like nodes are treated as async even without edge metadata.
 */
export function edgeRepresentsAsyncBoundary(e: Record<string, unknown>, graph?: ParsedLintGraph): boolean {
  const cfg = e.config;
  const meta = e.metadata;
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? (cfg as Record<string, unknown>) : undefined;
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
  if (m?.async === true || c?.async === true) return true;
  const proto = String(m?.protocol ?? c?.protocol ?? '').toLowerCase();
  if (proto === 'async' || proto === 'message' || proto === 'queue' || proto === 'event' || proto === 'pubsub') {
    return true;
  }
  const topKind = String(e.kind ?? '').toLowerCase();
  const kind = String(m?.kind ?? c?.kind ?? topKind ?? '').toLowerCase();
  if (/queue|topic|stream|kafka|sns|sqs|amqp|mqtt|nats/.test(kind)) return true;
  if (graph) {
    const { to } = edgeEndpoints(e);
    if (to) {
      const tn = graph.nodeById.get(to);
      if (tn && isQueueLikeNodeType(nodeType(tn))) return true;
    }
  }
  return false;
}

/** Adjacency for sync-only dependency depth (omits edges marked async). */
export function buildSyncAdjacencyForLint(g: ParsedLintGraph): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const id of g.nodeById.keys()) m.set(id, []);
  for (const e of g.edges) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    if (edgeRepresentsAsyncBoundary(rec, g)) continue;
    const { from, to } = edgeEndpoints(rec);
    if (!from || !to || !g.nodeById.has(from) || !g.nodeById.has(to)) continue;
    m.get(from)!.push(to);
  }
  return m;
}

/**
 * Build a parsed graph for lint visitors.
 * On failure (invalid IR root, empty graph, etc.) returns `{ findings }` with IR-STRUCT-* errors instead of `null`.
 */
export function buildParsedLintGraph(ir: unknown): BuildParsedLintGraphResult {
  const norm = normalizeIrGraph(ir);
  if ('findings' in norm) return { findings: norm.findings };

  const graph = norm.graph;
  const nodesRaw = graph.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    return {
      findings: [
        {
          code: 'IR-STRUCT-EMPTY_GRAPH',
          severity: 'error',
          message: 'Graph has no nodes',
          fixHint: 'Add at least one node before running architecture lint.',
        },
      ],
    };
  }

  const { normalized } = materializeNormalizedGraph(graph);

  const nodeById = new Map<string, Record<string, unknown>>();
  for (const n of normalized.nodes) {
    if (!n.id) continue;
    nodeById.set(n.id, {
      id: n.id,
      type: n.type,
      name: n.name,
      config: n.config,
      schema: n.schema,
    });
  }

  const edges: unknown[] = normalized.edges as unknown[];
  const adj = new Map<string, string[]>();
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();

  for (const id of nodeById.keys()) {
    adj.set(id, []);
    outDegree.set(id, 0);
    inDegree.set(id, 0);
  }

  for (const ne of normalized.edges) {
    const { from, to } = ne;
    if (!from || !to || !nodeById.has(from) || !nodeById.has(to)) continue;
    adj.get(from)!.push(to);
    outDegree.set(from, (outDegree.get(from) || 0) + 1);
    inDegree.set(to, (inDegree.get(to) || 0) + 1);
  }

  return { nodeById, edges, adj, outDegree, inDegree };
}

/** Type guard: successful parse vs structural blockers. */
export function isParsedLintGraph(r: BuildParsedLintGraphResult): r is ParsedLintGraph {
  return 'nodeById' in r && r.nodeById instanceof Map;
}
