/**
 * Deterministic structural validation of blueprint IR (graph JSON).
 * OSS boundary: shape, references, cycles — not security/compliance semantics (ArchRad Cloud).
 */

import { isHttpEndpointType } from './graphPredicates.js';
import { materializeNormalizedGraph } from './ir-normalize.js';

export type IrStructuralSeverity = 'error' | 'warning' | 'info';

/** IR shape/refs (IR-STRUCT-*) vs deterministic architecture heuristics (IR-LINT-*) */
export type IrFindingLayer = 'structural' | 'lint';

export type IrStructuralFinding = {
  code: string;
  severity: IrStructuralSeverity;
  message: string;
  /** Primary node id when relevant */
  nodeId?: string;
  /** Index in graph.edges[] */
  edgeIndex?: number;
  /** Short actionable hint (structural); also used as primary “Fix:” line in CLI when no suggestion */
  fixHint?: string;
  /** Set for IR-LINT-* findings */
  layer?: IrFindingLayer;
  /** Longer lint guidance (CLI “Suggestion:”) */
  suggestion?: string;
  /** Risk/context line (CLI “Impact:”) */
  impact?: string;
};

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Normalize product / CLI shapes to a single graph object.
 * Accepts `{ graph: { nodes, edges } }` or a bare `{ nodes, edges }`.
 */
export function normalizeIrGraph(ir: unknown): { graph: Record<string, unknown> } | { findings: IrStructuralFinding[] } {
  if (ir == null || typeof ir !== 'object') {
    return {
      findings: [
        {
          code: 'IR-STRUCT-INVALID_ROOT',
          severity: 'error',
          message: 'IR must be a JSON object',
          fixHint: 'Use an object with a `graph` key or a graph object with a `nodes` array.',
        },
      ],
    };
  }
  const o = ir as Record<string, unknown>;
  if (o.graph != null && typeof o.graph === 'object') {
    return { graph: o.graph as Record<string, unknown> };
  }
  if (Array.isArray(o.nodes)) {
    return { graph: o };
  }
  return {
    findings: [
      {
        code: 'IR-STRUCT-NO_GRAPH',
        severity: 'error',
        message: 'IR has no graph: expected `.graph` or top-level `.nodes` array',
        fixHint: 'Use { "graph": { "nodes": [], "edges": [] } } or { "nodes": [], "edges": [] }.',
      },
    ],
  };
}

/**
 * DFS cycle detector. Returns the cycle as an ordered node-id array (the repeated node is first)
 * or `null` if the graph is acyclic. Extracted for testability and to avoid closure over mutable state.
 */
export function detectCycles(adj: Map<string, string[]>): string[] | null {
  const visiting = new Map<string, number>(); // node → index in path when first entered
  const path: string[] = [];
  const done = new Set<string>();

  function dfs(u: string): string[] | null {
    if (visiting.has(u)) return path.slice(visiting.get(u)!);
    if (done.has(u)) return null;
    visiting.set(u, path.length);
    path.push(u);
    for (const v of adj.get(u) ?? []) {
      const cycle = dfs(v);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(u);
    done.add(u);
    return null;
  }

  for (const id of adj.keys()) {
    if (!done.has(id)) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Structural validation only: well-formed graph, edge references, directed cycles, HTTP node config.
 * Same input → same findings (deterministic).
 */
export function validateIrStructural(ir: unknown): IrStructuralFinding[] {
  const norm = normalizeIrGraph(ir);
  if ('findings' in norm) return norm.findings;

  const graph = norm.graph;
  const findings: IrStructuralFinding[] = [];

  if (!Array.isArray(graph.nodes)) {
    findings.push({
      code: 'IR-STRUCT-NODES_NOT_ARRAY',
      severity: 'error',
      message: '`nodes` must be an array',
      fixHint: 'Set `nodes` to at least one node object.',
    });
    return findings;
  }

  const nodes = graph.nodes as unknown[];
  if (nodes.length === 0) {
    findings.push({
      code: 'IR-STRUCT-EMPTY_GRAPH',
      severity: 'error',
      message: 'Graph has no nodes',
      fixHint: 'Add at least one node to export API code.',
    });
    return findings;
  }
  const { normalized, edgesInputWasMalformed } = materializeNormalizedGraph(graph);
  if (edgesInputWasMalformed) {
    findings.push({
      code: 'IR-STRUCT-EDGES_NOT_ARRAY',
      severity: 'warning',
      message: '`edges` is present but not an array; treating as []',
      fixHint: 'Set `edges` to an array of edge objects.',
    });
  }

  const edges: unknown[] = Array.isArray(graph.edges) ? (graph.edges as unknown[]) : [];

  /** Ids that appear on at least one valid node object with a non-empty id */
  const seenIds = new Set<string>();
  /** Ids that appear on more than one node — edges must not treat these as unambiguous */
  const duplicateIds = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const nn = normalized.nodes[i];
    if (n == null || typeof n !== 'object') {
      findings.push({
        code: 'IR-STRUCT-NODE_INVALID',
        severity: 'error',
        message: `Node at index ${i} is not an object`,
        fixHint: 'Each node must be a JSON object with an `id`.',
      });
      continue;
    }
    const id = nn.id;
    if (!id) {
      findings.push({
        code: 'IR-STRUCT-NODE_NO_ID',
        severity: 'error',
        message: `Node at index ${i} is missing a non-empty \`id\``,
        fixHint: 'Assign a stable string id to every node.',
      });
      continue;
    }
    if (seenIds.has(id)) {
      duplicateIds.add(id);
      findings.push({
        code: 'IR-STRUCT-DUP_NODE_ID',
        severity: 'error',
        message: `Duplicate node id "${id}"`,
        nodeId: id,
        fixHint: 'Ids must be unique across nodes.',
      });
    } else {
      seenIds.add(id);
    }

    const rawCfg = (n as Record<string, unknown>).config;
    if (rawCfg !== undefined) {
      const cfgInvalid = rawCfg === null || Array.isArray(rawCfg) || typeof rawCfg !== 'object';
      if (cfgInvalid) {
        const got = rawCfg === null ? 'null' : Array.isArray(rawCfg) ? 'array' : typeof rawCfg;
        findings.push({
          code: 'IR-STRUCT-NODE_INVALID_CONFIG',
          severity: 'warning',
          message: `Node "${id}" has a non-object \`config\` (got ${got}); treated as {}`,
          nodeId: id,
          fixHint: 'Set `config` to a plain object, e.g. { "url": "/foo", "method": "GET" }.',
        });
      }
    }

    if (isHttpEndpointType(nn.type)) {
      const cfg = nn.config;
      /** Generators accept `route` or `url`; structural checks align so OpenAPI merge + ingest both validate. */
      const url = String(cfg.url ?? cfg.route ?? '').trim();
      // Align default with generators (pythonFastAPI / nodeExpress use post when omitted)
      const method = String(cfg.method ?? 'post').trim();
      if (!url.startsWith('/')) {
        findings.push({
          code: 'IR-STRUCT-HTTP_PATH',
          severity: 'error',
          message: `HTTP endpoint node "${id}" has invalid path: config.url must be a non-empty string starting with /`,
          nodeId: id,
          fixHint: 'Set config.url (or config.route) to e.g. "/signup".',
        });
      }
      const m = method.toUpperCase();
      if (!HTTP_METHODS.has(m)) {
        findings.push({
          code: 'IR-STRUCT-HTTP_METHOD',
          severity: 'error',
          message: `HTTP endpoint node "${id}" has unsupported method "${method}"`,
          nodeId: id,
          fixHint: 'Use GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS.',
        });
      }
    }
  }

  const isUniqueNodeRef = (id: string): boolean => seenIds.has(id) && !duplicateIds.has(id);

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const ne = normalized.edges[i];
    if (e == null || typeof e !== 'object') {
      findings.push({
        code: 'IR-STRUCT-EDGE_INVALID',
        severity: 'error',
        message: `Edge at index ${i} is not an object`,
        edgeIndex: i,
        fixHint: 'Each edge must be an object with from/to (or source/target).',
      });
      continue;
    }
    const { from, to } = ne;
    if (!from || !to) {
      findings.push({
        code: 'IR-STRUCT-EDGE_NO_ENDPOINTS',
        severity: 'error',
        message: `Edge at index ${i} is missing from/source or to/target`,
        edgeIndex: i,
        fixHint: 'Set from→to or source→target to existing node ids.',
      });
      continue;
    }
    if (duplicateIds.has(from)) {
      findings.push({
        code: 'IR-STRUCT-EDGE_AMBIGUOUS_FROM',
        severity: 'error',
        message: `Edge at index ${i} references duplicate node id "${from}" (ambiguous source)`,
        edgeIndex: i,
        nodeId: from,
        fixHint: 'Resolve duplicate node ids before edges can reference them unambiguously.',
      });
    } else if (!seenIds.has(from)) {
      findings.push({
        code: 'IR-STRUCT-EDGE_UNKNOWN_FROM',
        severity: 'error',
        message: `Edge at index ${i} references unknown source node "${from}"`,
        edgeIndex: i,
        nodeId: from,
        fixHint: 'Create a node with this id or fix the edge endpoint.',
      });
    }
    if (duplicateIds.has(to)) {
      findings.push({
        code: 'IR-STRUCT-EDGE_AMBIGUOUS_TO',
        severity: 'error',
        message: `Edge at index ${i} references duplicate node id "${to}" (ambiguous target)`,
        edgeIndex: i,
        nodeId: to,
        fixHint: 'Resolve duplicate node ids before edges can reference them unambiguously.',
      });
    } else if (!seenIds.has(to)) {
      findings.push({
        code: 'IR-STRUCT-EDGE_UNKNOWN_TO',
        severity: 'error',
        message: `Edge at index ${i} references unknown target node "${to}"`,
        edgeIndex: i,
        nodeId: to,
        fixHint: 'Create a node with this id or fix the edge endpoint.',
      });
    }
  }

  const adj = new Map<string, string[]>();
  for (const ne of normalized.edges) {
    const { from, to } = ne;
    if (!from || !to || !isUniqueNodeRef(from) || !isUniqueNodeRef(to)) continue;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(to);
  }

  const cyclePath = detectCycles(adj);
  if (cyclePath !== null) {
    const nodeId = cyclePath[0];
    const pathStr = [...cyclePath, cyclePath[0]].join(' → ');
    findings.push({
      code: 'IR-STRUCT-CYCLE',
      severity: 'error',
      message: `Directed cycle detected: ${pathStr}`,
      nodeId,
      fixHint: 'Remove or break cyclic edges unless your tooling explicitly allows execution loops.',
    });
  }

  return findings;
}

export function hasIrStructuralErrors(findings: IrStructuralFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}
