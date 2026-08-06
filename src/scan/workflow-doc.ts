/**
 * Convert a canonical IR graph (typically `archrad scan` draft IR) into the
 * ArchRad Cloud workflow-document shape: `{ metadata, nodes, edges }` with
 * `source`/`target` edges and deterministic canvas positions.
 *
 * Deterministic by construction: same IR in → byte-identical document out.
 * Layout is tiered left-to-right (entry → compute → messaging → data/infra);
 * within a tier, nodes sort lexically by id and wrap into sub-columns.
 * `config` (including `config.provenance` file:line citations) passes through
 * untouched so the canvas can render cited nodes.
 */

import {
  isDbLikeType,
  isHttpLikeType,
  isInfraLeafSinkLintType,
  isQueueLikeNodeType,
} from '../graphPredicates.js';

export type WorkflowDocPosition = { x: number; y: number };

export type WorkflowDocNode = {
  id: string;
  type: string;
  label: string;
  position: WorkflowDocPosition;
  config?: Record<string, unknown>;
};

export type WorkflowDocEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  protocol?: string;
  transport?: 'sync' | 'async';
  relationshipType?: string;
  config?: Record<string, unknown>;
};

export type WorkflowDocMetadata = {
  name: string;
  description?: string;
  /** Carried from IR metadata (e.g. `"draft"` for scan output). */
  status?: string;
  /** Carried from IR metadata (e.g. scan extractor list + file count). */
  provenance?: Record<string, unknown>;
};

export type WorkflowDoc = {
  metadata: WorkflowDocMetadata;
  nodes: WorkflowDocNode[];
  edges: WorkflowDocEdge[];
};

export type IrToWorkflowDocOptions = {
  /** Override the document name (defaults to IR `graph.metadata.name`). */
  name?: string;
};

/** Layout constants — exported for tests only. */
export const LAYOUT = {
  /** Max nodes stacked vertically before a tier wraps into a new sub-column. */
  maxRows: 12,
  originX: 80,
  originY: 80,
  columnWidth: 280,
  rowHeight: 130,
  /** Horizontal gap between tiers, on top of their sub-column widths. */
  tierGap: 140,
} as const;

/** Tier index for the left-to-right layout: entry(0) → compute(1) → messaging(2) → data/infra(3). */
export function layoutTier(nodeType: string): number {
  const t = String(nodeType ?? '');
  if (isDbLikeType(t) || isInfraLeafSinkLintType(t)) return 3;
  if (isQueueLikeNodeType(t)) return 2;
  if (isHttpLikeType(t)) return 0;
  return 1;
}

type RawGraph = {
  metadata?: Record<string, unknown>;
  nodes?: unknown;
  edges?: unknown;
};

function graphOf(ir: Record<string, unknown>): RawGraph {
  const g = ir && typeof ir === 'object' && 'graph' in ir ? (ir as { graph: unknown }).graph : ir;
  return g && typeof g === 'object' && !Array.isArray(g) ? (g as RawGraph) : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
  );
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function configOf(element: Record<string, unknown>): Record<string, unknown> | undefined {
  const c = element.config;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : undefined;
}

/**
 * Deterministic positions for the given nodes. Nodes are grouped into tiers by
 * type, sorted lexically by id within a tier, and wrapped into sub-columns of
 * at most {@link LAYOUT.maxRows} rows so wide graphs stay readable.
 */
export function layoutPositions(
  nodes: { id: string; type: string }[],
): Map<string, WorkflowDocPosition> {
  const tiers: { id: string }[][] = [[], [], [], []];
  for (const node of [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    tiers[layoutTier(node.type)]!.push(node);
  }

  const positions = new Map<string, WorkflowDocPosition>();
  let tierX = LAYOUT.originX;
  for (const tier of tiers) {
    if (tier.length === 0) continue;
    const subColumns = Math.ceil(tier.length / LAYOUT.maxRows);
    tier.forEach((node, i) => {
      const subCol = Math.floor(i / LAYOUT.maxRows);
      const row = i % LAYOUT.maxRows;
      positions.set(node.id, {
        x: tierX + subCol * LAYOUT.columnWidth,
        y: LAYOUT.originY + row * LAYOUT.rowHeight,
      });
    });
    tierX += subColumns * LAYOUT.columnWidth + LAYOUT.tierGap;
  }
  return positions;
}

/**
 * Convert a canonical IR (`{ graph: { metadata, nodes, edges } }` or a bare
 * graph object) into a workflow document. Edges whose endpoints are missing
 * from the node set are dropped — the canvas cannot render dangling edges.
 */
export function irToWorkflowDoc(
  ir: Record<string, unknown>,
  options: IrToWorkflowDocOptions = {},
): WorkflowDoc {
  const graph = graphOf(ir);
  const meta = graph.metadata && typeof graph.metadata === 'object' ? graph.metadata : {};
  const rawNodes = asRecords(graph.nodes);
  const rawEdges = asRecords(graph.edges);

  const nodes: WorkflowDocNode[] = [];
  const nodeIds = new Set<string>();
  for (const raw of rawNodes) {
    const id = str(raw.id);
    if (!id || nodeIds.has(id)) continue;
    nodeIds.add(id);
    const type = str(raw.type) ?? 'service';
    const node: WorkflowDocNode = {
      id,
      type,
      label: str(raw.name) ?? id,
      position: { x: 0, y: 0 },
    };
    const config = configOf(raw);
    if (config) node.config = config;
    nodes.push(node);
  }

  const positions = layoutPositions(nodes);
  for (const node of nodes) {
    node.position = positions.get(node.id) ?? { x: LAYOUT.originX, y: LAYOUT.originY };
  }

  const edges: WorkflowDocEdge[] = [];
  const seenEdgeIds = new Set<string>();
  rawEdges.forEach((raw, index) => {
    const source = str(raw.from) ?? str(raw.source);
    const target = str(raw.to) ?? str(raw.target);
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) return;

    let id = str(raw.id) ?? `e_${source}_${target}_${index}`;
    while (seenEdgeIds.has(id)) id = `${id}_dup`;
    seenEdgeIds.add(id);

    const edge: WorkflowDocEdge = { id, source, target };
    const metadata =
      raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : undefined;
    if (metadata) {
      const relation = str(metadata.relation);
      if (relation) {
        edge.relationshipType = relation;
        edge.label = relation;
      }
      const protocol = str(metadata.protocol);
      if (protocol) edge.protocol = protocol;
      if (typeof metadata.async === 'boolean') edge.transport = metadata.async ? 'async' : 'sync';
    }
    const config = configOf(raw);
    if (config) edge.config = config;
    edges.push(edge);
  });

  const metadata: WorkflowDocMetadata = {
    name: options.name ?? str((meta as Record<string, unknown>).name) ?? 'Scanned architecture',
  };
  const description = str((meta as Record<string, unknown>).description);
  if (description) metadata.description = description;
  const status = str((meta as Record<string, unknown>).status);
  if (status) metadata.status = status;
  const provenance = (meta as Record<string, unknown>).provenance;
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
    metadata.provenance = provenance as Record<string, unknown>;
  }

  return { metadata, nodes, edges };
}
