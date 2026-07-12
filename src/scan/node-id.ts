/**
 * Canonical node-id construction for scan extractors.
 *
 * All extractors route their node ids through {@link scanNodeId} so that two
 * extractors describing the same component (e.g. a Postgres database found in
 * both docker-compose and application code) produce the SAME id — which is what
 * lets the confidence-aware merger recognize agreement and union provenance.
 * See docs/SPEC-scan.md §6, §11.
 */

/** Lowercase slug: non-alphanumerics → `_`, trimmed, length-capped. */
export function scanSlug(s: string): string {
  return String(s ?? '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 48);
}

/**
 * Canonical id for a node of a given `kind` (its IR `type`) and human `name`.
 *
 * - `scanNodeId('postgres', 'postgres')` → `"postgres"` (kind===name, no doubling)
 * - `scanNodeId('gateway', 'api')`       → `"gateway_api"`
 * - `scanNodeId('cache', 'redis')`       → `"cache_redis"`
 */
export function scanNodeId(kind: string, name: string): string {
  const k = scanSlug(kind);
  const n = scanSlug(name);
  if (!n) return k || 'node';
  if (!k || n === k || n.startsWith(`${k}_`)) return n;
  return `${k}_${n}`.slice(0, 96);
}

/**
 * Remap every id in a set of nodes/edges to its canonical {@link scanNodeId}.
 * Returns a new `{ nodes, edges }` plus the `idMap` (oldId → newId).
 *
 * Collisions (two source nodes mapping to the same canonical id but differing in
 * body) get a deterministic numeric suffix so no node is silently dropped.
 */
export function canonicalizeIds(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
): {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  idMap: Map<string, string>;
} {
  const idMap = new Map<string, string>();
  const usedBy = new Map<string, string>(); // canonicalId → sourceId that claimed it

  for (const node of nodes) {
    const oldId = typeof node.id === 'string' ? node.id : '';
    if (!oldId) continue;
    const kind = typeof node.type === 'string' ? node.type : '';
    const name = typeof node.name === 'string' ? node.name : oldId;
    let candidate = scanNodeId(kind, name);
    // Deterministic de-collision: only if a *different* source id already took it.
    if (usedBy.has(candidate) && usedBy.get(candidate) !== oldId) {
      let suffix = 2;
      while (usedBy.has(`${candidate}_${suffix}`)) suffix++;
      candidate = `${candidate}_${suffix}`;
    }
    usedBy.set(candidate, oldId);
    idMap.set(oldId, candidate);
  }

  const remappedNodes = nodes.map((n) => {
    const oldId = typeof n.id === 'string' ? n.id : '';
    return { ...n, id: idMap.get(oldId) ?? oldId };
  });

  const remappedEdges = edges.map((e) => {
    const from = typeof e.from === 'string' ? e.from : undefined;
    const to = typeof e.to === 'string' ? e.to : undefined;
    return {
      ...e,
      ...(from ? { from: idMap.get(from) ?? from } : {}),
      ...(to ? { to: idMap.get(to) ?? to } : {}),
    };
  });

  return { nodes: remappedNodes, edges: remappedEdges, idMap };
}
