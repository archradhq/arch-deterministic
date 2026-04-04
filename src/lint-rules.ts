/**
 * Architecture lint as a registry of visitor functions: each rule inspects ParsedLintGraph
 * and returns IrStructuralFinding[] (layer: lint). Deterministic, no AI, no cloud.
 */

import type { IrStructuralFinding } from './ir-structural.js';
import type { ParsedLintGraph } from './lint-graph.js';
import {
  edgeEndpoints,
  nodeType,
  isDbLikeType,
  isHttpLikeType,
  looksLikeHealthUrl,
  buildSyncAdjacencyForLint,
  edgeRepresentsAsyncBoundary,
} from './lint-graph.js';
import { isAuthLikeNodeType, isQueueLikeNodeType } from './graphPredicates.js';

const LAYER: IrStructuralFinding['layer'] = 'lint';

/** IR-LINT-DIRECT-DB-ACCESS-002 — HTTP-like → datastore-like in one hop (broader than strict api/gateway + database enum). */
export function ruleDirectDbAccess(g: ParsedLintGraph): IrStructuralFinding[] {
  const findings: IrStructuralFinding[] = [];
  const seenPair = new Set<string>();
  for (const e of g.edges) {
    if (!e || typeof e !== 'object') continue;
    const { from, to } = edgeEndpoints(e as Record<string, unknown>);
    if (!from || !to) continue;
    const pairKey = `${from}\0${to}`;
    const a = g.nodeById.get(from);
    const b = g.nodeById.get(to);
    if (!a || !b) continue;
    const ta = nodeType(a);
    const tb = nodeType(b);
    if (isHttpLikeType(ta) && isDbLikeType(tb)) {
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      findings.push({
        code: 'IR-LINT-DIRECT-DB-ACCESS-002',
        severity: 'warning',
        layer: LAYER,
        message: `API node "${from}" connects directly to datastore node "${to}"`,
        nodeId: from,
        fixHint: 'Introduce a service or domain layer between HTTP handlers and persistence.',
        suggestion: 'Route traffic through an application/service node so HTTP is not coupled to a single DB node.',
        impact: 'Harder to test, swap storage, or enforce invariants at a single boundary.',
      });
    }
  }
  return findings;
}

/** IR-LINT-HIGH-FANOUT-004 */
export function ruleHighFanout(g: ParsedLintGraph): IrStructuralFinding[] {
  const FANOUT_THRESHOLD = 5;
  const findings: IrStructuralFinding[] = [];
  for (const [id, deg] of g.outDegree) {
    if (deg >= FANOUT_THRESHOLD) {
      findings.push({
        code: 'IR-LINT-HIGH-FANOUT-004',
        severity: 'warning',
        layer: LAYER,
        message: `Node "${id}" has ${deg} outgoing dependencies (threshold ${FANOUT_THRESHOLD})`,
        nodeId: id,
        fixHint: 'Split responsibilities or group related downstream calls.',
        suggestion: 'Consider a facade, batching, or async handoff to reduce coupling and blast radius.',
        impact: 'Hotspots for change, failure, and latency under load.',
      });
    }
  }
  return findings;
}

/**
 * IR-LINT-SYNC-CHAIN-001 — longest **synchronous** path from HTTP entry nodes.
 * Edges marked async (see `edgeRepresentsAsyncBoundary` in `lint-graph.ts`) are excluded from depth.
 *
 * **HTTP entry roots:** Prefer HTTP-like nodes with **no incoming sync** edges. If every HTTP-like node
 * has an incoming sync edge (e.g. internal-only graph shape), we **fall back** to treating **all** HTTP-like
 * nodes as possible starts so the rule can still surface deep sync chains. See `docs/ENGINEERING_NOTES.md`.
 */
export function ruleSyncChainFromHttpEntry(g: ParsedLintGraph): IrStructuralFinding[] {
  const { edges, nodeById } = g;
  const syncAdj = buildSyncAdjacencyForLint(g);
  const hasIncomingSync = new Set<string>();
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    if (edgeRepresentsAsyncBoundary(rec, g)) continue;
    const { to } = edgeEndpoints(rec);
    if (to) hasIncomingSync.add(to);
  }
  const httpEntryIds: string[] = [];
  for (const [id, n] of nodeById) {
    if (isHttpLikeType(nodeType(n)) && !hasIncomingSync.has(id)) httpEntryIds.push(id);
  }
  const starts =
    httpEntryIds.length > 0
      ? httpEntryIds
      : [...nodeById.keys()].filter((id) => isHttpLikeType(nodeType(nodeById.get(id)!)));

  const memo = new Map<string, number>();
  function maxDepth(u: string, stack: Set<string>): number {
    if (stack.has(u)) return 0;
    if (memo.has(u)) return memo.get(u)!;
    stack.add(u);
    let d = 0;
    for (const v of syncAdj.get(u) || []) {
      d = Math.max(d, 1 + maxDepth(v, stack));
    }
    stack.delete(u);
    memo.set(u, d);
    return d;
  }

  const SYNC_CHAIN_THRESHOLD = 3;
  let maxChain = 0;
  for (const start of starts) {
    memo.clear();
    maxChain = Math.max(maxChain, maxDepth(start, new Set()));
  }

  if (maxChain >= SYNC_CHAIN_THRESHOLD && starts.length > 0) {
    return [
      {
        code: 'IR-LINT-SYNC-CHAIN-001',
        severity: 'warning',
        layer: LAYER,
        message: `Long synchronous dependency chain from HTTP entry (depth ≈ ${maxChain} hops; async-marked edges excluded)`,
        fixHint: 'Shorten the call graph or mark message/queue edges as async in edge metadata.',
        suggestion:
          'Set `metadata.protocol: "async"` or `config.async: true` on non-blocking edges, or use queues between services.',
        impact: 'High tail latency and failure amplification under load when calls are actually synchronous.',
      },
    ];
  }
  return [];
}

/** IR-LINT-NO-HEALTHCHECK-003 */
export function ruleNoHealthcheck(g: ParsedLintGraph): IrStructuralFinding[] {
  const httpNodes = [...g.nodeById.entries()].filter(([, n]) => isHttpLikeType(nodeType(n)));
  if (httpNodes.length === 0) return [];

  for (const [, n] of httpNodes) {
    const cfg = (n.config as Record<string, unknown>) || {};
    const url = String(cfg.url ?? '').trim();
    if (looksLikeHealthUrl(url)) return [];
  }

  return [
    {
      code: 'IR-LINT-NO-HEALTHCHECK-003',
      severity: 'warning',
      layer: LAYER,
      message:
        'No HTTP node exposes a typical health/readiness path (/health, /healthz, /healthcheck, /ping, /status, /live, /ready). Heuristic: one route per HTTP node; gateway/BFF with many routes may need a dedicated health node.',
      fixHint: 'Add a GET route such as /health for orchestrators and load balancers.',
      suggestion: 'Expose liveness vs readiness separately if your platform distinguishes them.',
      impact: 'Weaker deploy/rollback safety and harder operations automation.',
    },
  ];
}

/**
 * IR-LINT-ISOLATED-NODE-005 — node with no incident edges while the graph has at least one edge elsewhere.
 */
export function ruleIsolatedNode(g: ParsedLintGraph): IrStructuralFinding[] {
  if (g.edges.length === 0 || g.nodeById.size <= 1) return [];
  const findings: IrStructuralFinding[] = [];
  for (const [id] of g.nodeById) {
    const out = g.outDegree.get(id) ?? 0;
    const inn = g.inDegree.get(id) ?? 0;
    if (out === 0 && inn === 0) {
      findings.push({
        code: 'IR-LINT-ISOLATED-NODE-005',
        severity: 'warning',
        layer: LAYER,
        message: `Node "${id}" is not connected to any edge (disconnected subgraph)`,
        nodeId: id,
        fixHint: 'Remove the orphan node or add edges so it participates in the architecture.',
        suggestion: 'Disconnected nodes often indicate stale IR or a missing integration step.',
        impact: 'Export and reviews may not reflect real runtime behavior for this component.',
      });
    }
  }
  return findings;
}

/** IR-LINT-DUPLICATE-EDGE-006 — same from→to pair appears more than once. */
export function ruleDuplicateEdge(g: ParsedLintGraph): IrStructuralFinding[] {
  const seen = new Map<string, number>();
  const findings: IrStructuralFinding[] = [];
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    if (!e || typeof e !== 'object') continue;
    const { from, to } = edgeEndpoints(e as Record<string, unknown>);
    if (!from || !to) continue;
    const key = `${from}\0${to}`;
    if (seen.has(key)) {
      findings.push({
        code: 'IR-LINT-DUPLICATE-EDGE-006',
        severity: 'warning',
        layer: LAYER,
        message: `Duplicate edge from "${from}" to "${to}" (also at index ${seen.get(key)})`,
        edgeIndex: i,
        nodeId: from,
        fixHint: 'Collapse duplicate edges or distinguish them with metadata if your IR allows.',
        suggestion: 'Parallel duplicate edges rarely add information and clutter graph views.',
        impact: 'Downstream generators and metrics may double-count dependencies.',
      });
    } else {
      seen.set(key, i);
    }
  }
  return findings;
}

/** IR-LINT-HTTP-MISSING-NAME-007 */
export function ruleHttpMissingName(g: ParsedLintGraph): IrStructuralFinding[] {
  const findings: IrStructuralFinding[] = [];
  for (const [id, n] of g.nodeById) {
    if (!isHttpLikeType(nodeType(n))) continue;
    const name = String((n as Record<string, unknown>).name ?? '').trim();
    if (!name) {
      findings.push({
        code: 'IR-LINT-HTTP-MISSING-NAME-007',
        severity: 'warning',
        layer: LAYER,
        message: `HTTP-like node "${id}" has no display name`,
        nodeId: id,
        fixHint: 'Set a short human-readable `name` for docs, OpenAPI titles, and team communication.',
        suggestion: 'Names appear in generated README snippets and UI graph labels when mirrored from IR.',
        impact: 'Harder to navigate large graphs and generated documentation.',
      });
    }
  }
  return findings;
}

/** IR-LINT-DATASTORE-NO-INCOMING-008 */
export function ruleDatastoreNoIncoming(g: ParsedLintGraph): IrStructuralFinding[] {
  const findings: IrStructuralFinding[] = [];
  for (const [id, n] of g.nodeById) {
    if (!isDbLikeType(nodeType(n))) continue;
    if ((g.inDegree.get(id) ?? 0) === 0) {
      findings.push({
        code: 'IR-LINT-DATASTORE-NO-INCOMING-008',
        severity: 'warning',
        layer: LAYER,
        message: `Datastore-like node "${id}" has no incoming edges`,
        nodeId: id,
        fixHint: 'Connect a service or migration path to this datastore, or remove it if unused.',
        suggestion: 'Orphan persistence nodes often mean the IR is incomplete or a dead component.',
        impact: 'Risk of shipping diagrams that do not match how data is actually written.',
      });
    }
  }
  return findings;
}

/** IR-LINT-MULTIPLE-HTTP-ENTRIES-009 — more than one HTTP node with no incoming edges (multiple public entry surfaces). */
export function ruleMultipleHttpEntries(g: ParsedLintGraph): IrStructuralFinding[] {
  const entries: string[] = [];
  for (const [id, n] of g.nodeById) {
    if (!isHttpLikeType(nodeType(n))) continue;
    if ((g.inDegree.get(id) ?? 0) === 0) entries.push(id);
  }
  if (entries.length <= 1) return [];
  return [
    {
      code: 'IR-LINT-MULTIPLE-HTTP-ENTRIES-009',
      severity: 'warning',
      layer: LAYER,
      message: `Multiple HTTP entry nodes with no incoming edges (${entries.length}): ${entries.join(', ')}`,
      fixHint: 'Consider a single API gateway or BFF, or document why multiple public surfaces are intentional.',
      suggestion: 'Many teams standardize on one northbound HTTP edge for auth, rate limits, and observability.',
      impact: 'Operational duplication and inconsistent cross-cutting concerns across entrypoints.',
    },
  ];
}

/**
 * IR-LINT-MISSING-AUTH-010 — HTTP entry node (no incoming sync edges) with no auth coverage.
 *
 * A node is considered auth-covered when ANY of:
 *   1. One of its immediate outgoing neighbours is an auth-like node type.
 *   2. An auth-like node has a direct edge TO it (auth-as-gateway pattern).
 *   3. Its own `config` carries an auth-signal key: `auth`, `authRequired`,
 *      `authentication`, `authorization`, or `security`.
 *
 * Escape hatch: set `config.authRequired: false` (explicit opt-out) to silence the rule
 * for intentionally public endpoints (health, public assets, etc.).
 */
export function ruleHttpMissingAuth(g: ParsedLintGraph): IrStructuralFinding[] {
  const { edges, nodeById, adj, inDegree } = g;

  // Entry = no valid incoming edge (same counts as buildParsedLintGraph.inDegree)
  // Build reverse adjacency: to → [from] for auth-coverage check #2 (valid endpoints only, same as adj)
  const reverseAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    const { from, to } = edgeEndpoints(e as Record<string, unknown>);
    if (!from || !to || !nodeById.has(from) || !nodeById.has(to)) continue;
    if (!reverseAdj.has(to)) reverseAdj.set(to, []);
    reverseAdj.get(to)!.push(from);
  }

  const findings: IrStructuralFinding[] = [];

  for (const [id, n] of nodeById) {
    if (!isHttpLikeType(nodeType(n))) continue;
    if ((inDegree.get(id) ?? 0) > 0) continue; // not an entry node

    const cfg = (n.config ?? {}) as Record<string, unknown>;

    // Explicit opt-out: config.authRequired === false marks an intentionally public endpoint
    if (cfg.authRequired === false) continue;

    // Coverage check 1: outgoing neighbour is auth-like
    const outNeighbours = adj.get(id) ?? [];
    if (outNeighbours.some((v) => isAuthLikeNodeType(nodeType(nodeById.get(v) ?? {})))) continue;

    // Coverage check 2: an auth-like node points directly to this entry node
    const inNeighbours = reverseAdj.get(id) ?? [];
    if (inNeighbours.some((v) => isAuthLikeNodeType(nodeType(nodeById.get(v) ?? {})))) continue;

    // Coverage check 3: node config carries an auth signal
    const authConfigKeys = ['auth', 'authrequired', 'authentication', 'authorization', 'security'];
    const cfgKeys = Object.keys(cfg).map((k) => k.toLowerCase());
    if (authConfigKeys.some((k) => cfgKeys.includes(k))) continue;

    findings.push({
      code: 'IR-LINT-MISSING-AUTH-010',
      severity: 'warning',
      layer: LAYER,
      message: `HTTP entry node "${id}" has no auth node or auth config in its immediate graph neighbourhood`,
      nodeId: id,
      fixHint: 'Add an auth/middleware node with an edge to or from this entry, or set config.authRequired: false for intentionally public endpoints.',
      suggestion:
        'Connect an auth, oauth, jwt, or middleware node. For PCI-DSS / HIPAA systems, every HTTP entry must have a documented auth boundary.',
      impact: 'Unauthenticated HTTP entry points are a compliance gap in regulated environments and a common attack surface.',
    });
  }

  return findings;
}

/**
 * IR-LINT-DEAD-NODE-011 — non-sink node with incoming edges but no outgoing edges.
 *
 * Datastore-like and queue-like nodes are valid sinks and are excluded.
 * Nodes with no incident edges at all are already caught by IR-LINT-ISOLATED-NODE-005.
 * This rule targets nodes that receive data but forward it nowhere — likely a missing
 * edge, an incomplete integration step, or a stale component.
 */
export function ruleDeadNode(g: ParsedLintGraph): IrStructuralFinding[] {
  const findings: IrStructuralFinding[] = [];

  for (const [id, n] of g.nodeById) {
    const out = g.outDegree.get(id) ?? 0;
    const inn = g.inDegree.get(id) ?? 0;
    if (out > 0 || inn === 0) continue; // has outgoing, or truly isolated (caught elsewhere)
    const t = nodeType(n);
    if (isDbLikeType(t) || isQueueLikeNodeType(t) || isHttpLikeType(t)) continue; // valid sinks
    findings.push({
      code: 'IR-LINT-DEAD-NODE-011',
      severity: 'warning',
      layer: LAYER,
      message: `Node "${id}" (type: ${t || 'unknown'}) receives edges but has no outgoing edges — possible missing integration or dead component`,
      nodeId: id,
      fixHint: 'Add an outgoing edge to a downstream node, or remove this node if it is no longer active.',
      suggestion: 'Dead-end non-sink nodes often represent incomplete migrations, dropped integrations, or copy-paste errors in the IR.',
      impact: 'Data entering this node has no documented path forward, which misrepresents runtime behaviour.',
    });
  }

  return findings;
}

/**
 * Ordered registry: add a new rule by implementing `(g) => findings` and appending here.
 */
export const LINT_RULE_REGISTRY: ReadonlyArray<(g: ParsedLintGraph) => IrStructuralFinding[]> = [
  ruleDirectDbAccess,
  ruleHighFanout,
  ruleSyncChainFromHttpEntry,
  ruleNoHealthcheck,
  ruleIsolatedNode,
  ruleDuplicateEdge,
  ruleHttpMissingName,
  ruleDatastoreNoIncoming,
  ruleMultipleHttpEntries,
  ruleHttpMissingAuth,
  ruleDeadNode,
];

/** Run all registered architecture lint visitors (same as legacy `validateIrLint` behavior). */
export function runArchitectureLinting(g: ParsedLintGraph): IrStructuralFinding[] {
  return LINT_RULE_REGISTRY.flatMap((rule) => rule(g));
}
