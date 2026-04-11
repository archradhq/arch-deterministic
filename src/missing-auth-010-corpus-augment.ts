/**
 * Normalizes minimal IR graphs used in the IR-LINT-MISSING-AUTH-010 training corpus so that
 * `validateIrLint` does not also emit IR-LINT-NO-HEALTHCHECK-003 or IR-LINT-DEAD-NODE-011
 * (unless the example is meant to test those rules).
 *
 * Training pairs live under `corpus/` (e.g. `corpus-auth-010-pairs.json`).
 * Not exported from the package public API — used by tests and optional tooling.
 */
import { isDbLikeType, isHttpLikeType, isQueueLikeNodeType } from './graphPredicates.js';

function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? n.kind ?? '').toLowerCase();
}

export function augmentCorpusGraph(ir: unknown): unknown {
  const wrap = ir as { graph?: { nodes?: unknown[]; edges?: unknown[] } };
  if (!wrap?.graph?.nodes || !Array.isArray(wrap.graph.edges)) return ir;
  const nodes = JSON.parse(JSON.stringify(wrap.graph.nodes)) as Record<string, unknown>[];
  const edges = JSON.parse(JSON.stringify(wrap.graph.edges)) as Record<string, unknown>[];

  // 1) One HTTP-like node with a health-like URL → satisfies IR-LINT-NO-HEALTHCHECK-003
  for (const n of nodes) {
    const t = nodeType(n);
    if (!isHttpLikeType(t)) continue;
    const cfg = ((n.config as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    if (!String(cfg.url ?? '').trim()) {
      n.config = { ...cfg, url: '/health' };
      break;
    }
  }

  const nodeById = new Set(nodes.map((n) => String(n.id)));
  const outCount = new Map<string, number>();
  const inCount = new Map<string, number>();
  for (const id of nodeById) {
    outCount.set(id, 0);
    inCount.set(id, 0);
  }
  for (const e of edges) {
    const from = String((e as { from?: unknown }).from ?? '');
    const to = String((e as { to?: unknown }).to ?? '');
    if (!from || !to || !nodeById.has(from) || !nodeById.has(to)) continue;
    outCount.set(from, (outCount.get(from) ?? 0) + 1);
    inCount.set(to, (inCount.get(to) ?? 0) + 1);
  }

  // 2) Leaf services (non-HTTP sink, non-DB) → edge to a synthetic database (avoids IR-LINT-DEAD-NODE-011)
  let sinkSeq = 0;
  for (const n of nodes) {
    const id = String(n.id);
    const t = nodeType(n);
    if (isHttpLikeType(t)) continue;
    if (isDbLikeType(t) || isQueueLikeNodeType(t)) continue;
    if ((outCount.get(id) ?? 0) > 0) continue;
    if ((inCount.get(id) ?? 0) === 0) continue;
    const sinkId = `__corpus_sink_${id}_${sinkSeq++}`;
    nodes.push({ id: sinkId, type: 'database', name: `Corpus sink for ${id}` });
    // Exclude from IR-LINT-SYNC-CHAIN-001 depth (sink is bookkeeping, not a sync RPC hop).
    edges.push({ from: id, to: sinkId, metadata: { protocol: 'async' } });
    nodeById.add(sinkId);
    outCount.set(id, (outCount.get(id) ?? 0) + 1);
    inCount.set(sinkId, (inCount.get(sinkId) ?? 0) + 1);
  }

  return { graph: { nodes, edges } };
}
