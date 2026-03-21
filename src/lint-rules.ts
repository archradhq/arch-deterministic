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
} from './lint-graph.js';

const LAYER: IrStructuralFinding['layer'] = 'lint';

/** IR-LINT-DIRECT-DB-ACCESS-002 — HTTP-like → datastore-like in one hop (broader than strict api/gateway + database enum). */
export function ruleDirectDbAccess(g: ParsedLintGraph): IrStructuralFinding[] {
  const findings: IrStructuralFinding[] = [];
  for (const e of g.edges) {
    if (!e || typeof e !== 'object') continue;
    const { from, to } = edgeEndpoints(e as Record<string, unknown>);
    if (!from || !to) continue;
    const a = g.nodeById.get(from);
    const b = g.nodeById.get(to);
    if (!a || !b) continue;
    const ta = nodeType(a);
    const tb = nodeType(b);
    if (isHttpLikeType(ta) && isDbLikeType(tb)) {
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

/** IR-LINT-SYNC-CHAIN-001 — longest path from HTTP entry nodes (all edges treated as sync; no edge.metadata required). */
export function ruleSyncChainFromHttpEntry(g: ParsedLintGraph): IrStructuralFinding[] {
  const { edges, adj, nodeById } = g;
  const hasIncoming = new Set<string>();
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    const { to } = edgeEndpoints(e as Record<string, unknown>);
    if (to) hasIncoming.add(to);
  }
  const httpEntryIds: string[] = [];
  for (const [id, n] of nodeById) {
    if (isHttpLikeType(nodeType(n)) && !hasIncoming.has(id)) httpEntryIds.push(id);
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
    for (const v of adj.get(u) || []) {
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
        message: `Long synchronous dependency chain from HTTP entry (depth ≈ ${maxChain} hops)`,
        fixHint: 'Shorten the call graph or introduce async/events between services.',
        suggestion: 'Break critical paths with queues, sagas, or parallel calls where safe.',
        impact: 'High tail latency and failure amplification under load.',
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
      message: 'No HTTP node exposes a typical health/readiness path (/health, /healthz, /live, /ready)',
      fixHint: 'Add a GET route such as /health for orchestrators and load balancers.',
      suggestion: 'Expose liveness vs readiness separately if your platform distinguishes them.',
      impact: 'Weaker deploy/rollback safety and harder operations automation.',
    },
  ];
}

/**
 * Ordered registry: add a new rule by implementing `(g) => findings` and appending here.
 */
export const LINT_RULE_REGISTRY: ReadonlyArray<(g: ParsedLintGraph) => IrStructuralFinding[]> = [
  ruleDirectDbAccess,
  ruleHighFanout,
  ruleSyncChainFromHttpEntry,
  ruleNoHealthcheck,
];

/** Run all registered architecture lint visitors (same as legacy `validateIrLint` behavior). */
export function runArchitectureLinting(g: ParsedLintGraph): IrStructuralFinding[] {
  return LINT_RULE_REGISTRY.flatMap((rule) => rule(g));
}
