/**
 * Merge multiple ArchRad IR JSON fragments into one graph.
 *
 * Default: union by `node.id` — identical definitions dedupe; conflicting ids → error + stderr report.
 * Optional `prefixFragments`: disjoint union (legacy) — prefix each fragment’s ids.
 */

import { stripLeadingTrailingUnderscores } from '../stringEdgeStrip.js';

export class FragmentMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentMergeError';
  }
}

/** Same `node.id` with incompatible definitions across fragments. */
export class FragmentMergeConflictError extends Error {
  constructor(
    message: string,
    public readonly reportLines: string[],
  ) {
    super(message);
    this.name = 'FragmentMergeConflictError';
  }
}

function getGraph(ir: Record<string, unknown>): Record<string, unknown> {
  const g = ir.graph && typeof ir.graph === 'object' && !Array.isArray(ir.graph) ? ir.graph : ir;
  return g as Record<string, unknown>;
}

function sanitizePrefix(label: string): string {
  const s = stripLeadingTrailingUnderscores(
    String(label || 'frag')
      .replace(/\.json$/i, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase(),
  ).slice(0, 40);
  return s || 'frag';
}

/** Prefix node id for merged graph uniqueness. */
export function prefixNodeId(prefix: string, nodeId: string): string {
  const p = sanitizePrefix(prefix);
  const id = String(nodeId);
  return `${p}__${id}`.slice(0, 120);
}

function sortKeysDeep(x: unknown): unknown {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(sortKeysDeep);
  const o = x as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    out[k] = sortKeysDeep(o[k]);
  }
  return out;
}

/** Canonical JSON for node body equality (id excluded from comparison). */
function nodeBodyFingerprint(node: Record<string, unknown>): string {
  const { id: _id, ...rest } = node;
  return JSON.stringify(sortKeysDeep(rest));
}

function edgeEndpoints(edge: Record<string, unknown>): { from: string; to: string } | null {
  const from = edge.from ?? edge.source;
  const to = edge.to ?? edge.target;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  return { from, to };
}

function edgeFingerprint(edge: Record<string, unknown>): string {
  const { from, to } = edgeEndpoints(edge) ?? { from: '', to: '' };
  const { from: _f, to: _t, source: _s, target: _tg, ...rest } = edge;
  return JSON.stringify({
    from,
    to,
    rest: sortKeysDeep(rest),
  });
}

export type MergeIrFragmentsOptions = {
  /** One label per fragment (defaults to fragment-0, fragment-1, …). */
  labels?: string[];
  /**
   * When true: prefix each fragment’s node/edge ids (disjoint union; no cross-fragment id checks).
   * When false (default): merge by global `node.id` with dedupe / conflict detection.
   */
  prefixFragments?: boolean;
};

export type MergeIrFragmentsResult = {
  ir: Record<string, unknown>;
  /** Non-fatal messages (stderr in CLI). */
  warnings: string[];
};

/**
 * Merge IR fragments. Default mode unions on `node.id`; conflicts throw {@link FragmentMergeConflictError}.
 */
export function mergeIrFragments(
  fragments: Record<string, unknown>[],
  options: MergeIrFragmentsOptions = {},
): MergeIrFragmentsResult {
  if (fragments.length < 2) {
    throw new FragmentMergeError('mergeIrFragments requires at least 2 IR fragments');
  }

  const labels =
    options.labels && options.labels.length === fragments.length
      ? options.labels.map(sanitizePrefix)
      : fragments.map((_, i) => `frag${i}`);

  if (options.prefixFragments) {
    return mergeWithPrefix(fragments, labels);
  }
  return mergeByNodeId(fragments, labels);
}

function mergeWithPrefix(
  fragments: Record<string, unknown>[],
  labels: string[],
): MergeIrFragmentsResult {
  const allNodes: unknown[] = [];
  const allEdges: unknown[] = [];
  const mergedFrom: { label: string; nodeCount: number; edgeCount: number }[] = [];

  for (let i = 0; i < fragments.length; i++) {
    const label = labels[i]!;
    const g = getGraph(fragments[i]!);
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const edges = Array.isArray(g.edges) ? g.edges : [];

    for (const n of nodes) {
      if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
      const node = n as Record<string, unknown>;
      const id = node.id;
      if (typeof id !== 'string' || !id.trim()) continue;
      allNodes.push({
        ...node,
        id: prefixNodeId(label, id),
      });
    }

    for (const e of edges) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const edge = e as Record<string, unknown>;
      const from = edge.from ?? edge.source;
      const to = edge.to ?? edge.target;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      allEdges.push({
        ...edge,
        from: prefixNodeId(label, from),
        to: prefixNodeId(label, to),
      });
    }

    mergedFrom.push({ label, nodeCount: nodes.length, edgeCount: edges.length });
  }

  if (allNodes.length === 0) {
    throw new FragmentMergeError('Merged graph would have no nodes (empty fragments?)');
  }

  return {
    ir: {
      metadata: { name: 'merged-ir' },
      graph: {
        metadata: {
          name: 'merged-ir',
          provenance: { source: 'fragment-merge', mode: 'prefix', fragments: mergedFrom },
        },
        nodes: allNodes,
        edges: allEdges,
      },
    },
    warnings: [],
  };
}

function mergeByNodeId(
  fragments: Record<string, unknown>[],
  labels: string[],
): MergeIrFragmentsResult {
  const warnings: string[] = [];

  type FirstSeen = { fingerprint: string; label: string; node: Record<string, unknown> };
  const byId = new Map<string, FirstSeen>();
  const conflicts: string[] = [];

  for (let i = 0; i < fragments.length; i++) {
    const label = labels[i]!;
    const g = getGraph(fragments[i]!);
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];

    for (const n of nodes) {
      if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
      const node = n as Record<string, unknown>;
      const id = node.id;
      if (typeof id !== 'string' || !id.trim()) continue;

      const fp = nodeBodyFingerprint(node);
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, { fingerprint: fp, label, node: { ...node } });
      } else if (prev.fingerprint !== fp) {
        conflicts.push(
          `CONFLICT [node: ${id}] definition mismatch: (${prev.label}) vs (${label})`,
        );
      }
    }
  }

  if (conflicts.length > 0) {
    const report = ['archrad fragment merge: unresolved conflicts — no output written.', '', ...conflicts];
    throw new FragmentMergeConflictError(report.join('\n'), report);
  }

  const nodeIds = new Set(byId.keys());
  const mergedNodes = [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v.node);

  const edgeSeen = new Set<string>();
  const mergedEdges: unknown[] = [];

  for (let i = 0; i < fragments.length; i++) {
    const label = labels[i]!;
    const g = getGraph(fragments[i]!);
    const edges = Array.isArray(g.edges) ? g.edges : [];

    for (const e of edges) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const edge = e as Record<string, unknown>;
      const ep = edgeEndpoints(edge);
      if (!ep) continue;
      if (!nodeIds.has(ep.from)) {
        warnings.push(`WARN [edge] unknown 'from' node "${ep.from}" (fragment ${label}) — edge skipped`);
        continue;
      }
      if (!nodeIds.has(ep.to)) {
        warnings.push(`WARN [edge] unknown 'to' node "${ep.to}" (fragment ${label}) — edge skipped`);
        continue;
      }
      const key = edgeFingerprint(edge);
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      mergedEdges.push({ ...edge });
    }
  }

  const mergedFrom = fragments.map((fr, i) => {
    const g = getGraph(fr);
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const edges = Array.isArray(g.edges) ? g.edges : [];
    return { label: labels[i]!, nodeCount: nodes.length, edgeCount: edges.length };
  });

  if (mergedNodes.length === 0) {
    throw new FragmentMergeError('Merged graph would have no nodes (empty fragments?)');
  }

  return {
    ir: {
      metadata: { name: 'merged-ir' },
      graph: {
        metadata: {
          name: 'merged-ir',
          provenance: { source: 'fragment-merge', mode: 'union-by-id', fragments: mergedFrom },
        },
        nodes: mergedNodes,
        edges: mergedEdges,
      },
    },
    warnings,
  };
}
