/**
 * Parser boundary: external IR → internal normalized graph shape.
 * Generators still receive the original IR object; use normalized form for validation/lint only.
 */

export type NormalizedNode = {
  id: string;
  /** Lowercased from `type` or `kind` */
  type: string;
  name: string;
  config: Record<string, unknown>;
  schema: Record<string, unknown>;
};

export type NormalizedEdge = {
  id: string;
  from: string;
  to: string;
  config: Record<string, unknown>;
};

export type NormalizedGraph = {
  metadata: Record<string, unknown>;
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
};

function emptyRecord(obj: unknown): Record<string, unknown> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
  return {};
}

/**
 * Coerce one node slot to the internal shape (invalid input → empty fields; structural rules flag issues).
 */
export function normalizeNodeSlot(raw: unknown): NormalizedNode {
  if (raw == null || typeof raw !== 'object') {
    return { id: '', type: '', name: '', config: {}, schema: {} };
  }
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim();
  const type = String(r.type ?? r.kind ?? '')
    .trim()
    .toLowerCase();
  const name = String(r.name ?? '').trim();
  return {
    id,
    type,
    name,
    config: emptyRecord(r.config),
    schema: emptyRecord(r.schema),
  };
}

/**
 * Coerce one edge slot to internal `from` / `to` (accepts legacy `source` / `target`).
 */
export function normalizeEdgeSlot(raw: unknown): NormalizedEdge {
  if (raw == null || typeof raw !== 'object') {
    return { id: '', from: '', to: '', config: {} };
  }
  const r = raw as Record<string, unknown>;
  const from = String(r.from ?? r.source ?? '').trim();
  const to = String(r.to ?? r.target ?? '').trim();
  const id = String(r.id ?? '').trim();
  return {
    id,
    from,
    to,
    config: emptyRecord(r.config),
  };
}

export type MaterializeResult = {
  normalized: NormalizedGraph;
  /** True when `edges` was present but not an array (treated as []). */
  edgesInputWasMalformed: boolean;
};

/**
 * Build internal normalized graph from an already-unwrapped `graph` object
 * (`normalizeIrGraph` must have succeeded). Does not validate semantics.
 */
export function materializeNormalizedGraph(graph: Record<string, unknown>): MaterializeResult {
  const metadata = emptyRecord(graph.metadata);

  const nodesRaw = Array.isArray(graph.nodes) ? (graph.nodes as unknown[]) : [];
  const nodes = nodesRaw.map((n) => normalizeNodeSlot(n));

  const edgesMalformed = graph.edges !== undefined && !Array.isArray(graph.edges);
  const edgesRaw = Array.isArray(graph.edges) ? (graph.edges as unknown[]) : [];
  const edges = edgesRaw.map((e) => normalizeEdgeSlot(e));

  return {
    normalized: {
      metadata,
      nodes,
      edges,
    },
    edgesInputWasMalformed: edgesMalformed,
  };
}
