/**
 * Confidence-aware merger for scan draft IR.
 *
 * Unlike `fragment/merge.ts` (which ERRORS on node-id conflicts), scan expects
 * overlap — two extractors describing the same component is the desired signal
 * that sources agree. So this merger RESOLVES overlap instead of failing:
 *
 *   1. Union nodes on `id`. On collision keep the highest-confidence body;
 *      ties break by extractor priority order, then lexical id.
 *   2. Union all provenance records onto the winner (deduped, sorted).
 *   3. Union edges on `(from, to, relation)` with the same policy.
 *   4. Drop edges whose endpoints did not survive (warn).
 *
 * See docs/SPEC-scan.md §6.
 */

import type { PartialIR, Provenance } from './types.js';
import { confidenceRank } from './types.js';
import {
  elementConfidence,
  normalizeProvenance,
  readProvenance,
} from './provenance.js';
import { isDbLikeType, isQueueLikeNodeType } from '../graphPredicates.js';

export type MergeDraftOptions = {
  /** Extractor names in canonical priority order (index 0 = highest priority). */
  priority: string[];
};

export type MergeDraftResult = {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  warnings: string[];
};

type Entry = {
  element: Record<string, unknown>;
  confRank: number;
  order: number;
  prov: Provenance[];
};

function rankOf(extractor: string, priority: string[]): number {
  const i = priority.indexOf(extractor);
  return i === -1 ? priority.length : i;
}

function edgeRelation(edge: Record<string, unknown>): string {
  const meta = edge.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const r = (meta as Record<string, unknown>).relation;
    if (typeof r === 'string') return r;
  }
  return '';
}

/**
 * Decide whether a candidate should replace the incumbent, then return the merged
 * entry (winning body + unioned provenance). Higher confidence wins; ties go to
 * the lower priority index (earlier extractor).
 */
function combine(incumbent: Entry, candidate: Entry): Entry {
  const candidateWins =
    candidate.confRank > incumbent.confRank ||
    (candidate.confRank === incumbent.confRank && candidate.order < incumbent.order);
  const winner = candidateWins ? candidate : incumbent;
  return {
    element: winner.element,
    confRank: winner.confRank,
    order: winner.order,
    prov: [...incumbent.prov, ...candidate.prov],
  };
}

/** Write the normalized provenance array back onto an element's `config`. */
function withMergedProvenance(
  element: Record<string, unknown>,
  prov: Provenance[],
): Record<string, unknown> {
  const config =
    element.config && typeof element.config === 'object' && !Array.isArray(element.config)
      ? (element.config as Record<string, unknown>)
      : {};
  return { ...element, config: { ...config, provenance: normalizeProvenance(prov) } };
}

export function mergeDraftFragments(
  partials: PartialIR[],
  options: MergeDraftOptions,
): MergeDraftResult {
  const { priority } = options;
  const warnings: string[] = [];

  // ----- Nodes -----
  const nodeById = new Map<string, Entry>();
  for (const partial of partials) {
    const order = rankOf(partial.extractor, priority);
    for (const node of partial.nodes) {
      const id = typeof node.id === 'string' ? node.id : '';
      if (!id) continue;
      const entry: Entry = {
        element: node,
        confRank: confidenceRank(elementConfidence(node)),
        order,
        prov: readProvenance(node),
      };
      const prev = nodeById.get(id);
      nodeById.set(id, prev ? combine(prev, entry) : entry);
    }
  }

  const survivingIds = new Set(nodeById.keys());

  // ----- Edges -----
  const edgeByKey = new Map<string, Entry>();
  for (const partial of partials) {
    const order = rankOf(partial.extractor, priority);
    for (const edge of partial.edges) {
      const from = typeof edge.from === 'string' ? edge.from : '';
      const to = typeof edge.to === 'string' ? edge.to : '';
      if (!from || !to) continue;
      if (!survivingIds.has(from)) {
        warnings.push(
          `archrad scan: dropped edge with unknown 'from' node "${from}" (extractor ${partial.extractor})`,
        );
        continue;
      }
      if (!survivingIds.has(to)) {
        warnings.push(
          `archrad scan: dropped edge with unknown 'to' node "${to}" (extractor ${partial.extractor})`,
        );
        continue;
      }
      const key = `${from} ${to} ${edgeRelation(edge)}`;
      const entry: Entry = {
        element: edge,
        confRank: confidenceRank(elementConfidence(edge)),
        order,
        prov: readProvenance(edge),
      };
      const prev = edgeByKey.get(key);
      edgeByKey.set(key, prev ? combine(prev, entry) : entry);
    }
  }

  const nodes = [...nodeById.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => withMergedProvenance(e.element, e.prov));

  const edges = [...edgeByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => withMergedProvenance(e.element, e.prov));

  return { nodes, edges, warnings };
}

// ---- post-merge unification --------------------------------------------------
//
// mergeDraftFragments above only unions nodes that already share an exact `id`.
// Two real cases slip past that: (a) the same physical infra under a different
// name per tier (manifest's `firestore` vs code's `firestore_firebase_admin`),
// and (b) the one app-under-scan represented by different node TYPES per tier
// (code's `gateway_server` vs manifest's `service_archrad_api`). Both are solved
// the same way: group candidate nodes by a looser equivalence, collapse each
// group to its best member, rewire edges, union provenance. See
// docs/SPEC-scan.md §11.

/** Lower is more specific/informative; used only to break ties within a unify group. */
const TYPE_SPECIFICITY: Record<string, number> = { gateway: 0, worker: 1 };
function typeSpecificity(node: Record<string, unknown>): number {
  const t = typeof node.type === 'string' ? node.type : '';
  return TYPE_SPECIFICITY[t] ?? 2;
}

function isScanRoot(node: Record<string, unknown>): boolean {
  const config = node.config;
  return (
    !!config &&
    typeof config === 'object' &&
    !Array.isArray(config) &&
    (config as Record<string, unknown>).scanRoot === true
  );
}

/** Infra types that realistically have ONE instance within a single scanned unit. */
const SINGLETON_INFRA_TYPES = new Set([
  'postgres', 'mysql', 'mongodb', 'cassandra', 'sqlserver', 'search', 'smtp', 'firestore', 'cache',
]);

/**
 * Collapse `group` (a subset of `allNodes` considered equivalent) into its single
 * best member: highest confidence, then most specific type, then extractor
 * priority. Every edge endpoint referencing a collapsed loser is rewired onto the
 * survivor; edges that collide as a result are re-deduped by (from, to, relation)
 * the same way the main merge does. A no-op when the group has fewer than 2 nodes.
 */
function collapseGroup(
  group: Record<string, unknown>[],
  allNodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  priority: string[],
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  // Defensive: exported callers could hand this raw, unvalidated nodes (unlike
  // mergeDraftFragments' own internal map, which only ever admits nodes with a
  // real string id). Drop anything without one before grouping, so a malformed
  // node can't collide with another under a shared `undefined` key.
  const validGroup = group.filter((n) => typeof n.id === 'string' && n.id);
  if (validGroup.length < 2) return { nodes: allNodes, edges };

  const ranked = validGroup
    .map((node) => {
      const provs = readProvenance(node);
      const bestOrder = provs.length
        ? Math.min(...provs.map((p) => rankOf(p.extractor, priority)))
        : priority.length;
      return { node, confRank: confidenceRank(elementConfidence(node)), typeR: typeSpecificity(node), bestOrder };
    })
    .sort((a, b) => b.confRank - a.confRank || a.typeR - b.typeR || a.bestOrder - b.bestOrder);

  const survivor = ranked[0]!.node;
  const survivorId = survivor.id as string;
  const losers = ranked.slice(1);
  const loserIds = new Set(losers.map((r) => r.node.id as string));

  const mergedProv = normalizeProvenance([
    ...readProvenance(survivor),
    ...losers.flatMap((r) => readProvenance(r.node)),
  ]);
  const mergedSurvivor = withMergedProvenance(survivor, mergedProv);

  const keptNodes = allNodes
    .filter((n) => !loserIds.has(n.id as string))
    .map((n) => (n.id === survivorId ? mergedSurvivor : n));

  const rewired = edges
    .map((e) => {
      const from = typeof e.from === 'string' && loserIds.has(e.from) ? survivorId : e.from;
      const to = typeof e.to === 'string' && loserIds.has(e.to) ? survivorId : e.to;
      return from === e.from && to === e.to ? e : { ...e, from, to };
    })
    .filter((e) => e.from !== e.to); // rewiring can turn an edge into a self-loop; drop it

  // Re-dedupe edges that collided after rewiring, same policy as the main merge.
  const edgeByKey = new Map<string, { edge: Record<string, unknown>; confRank: number; prov: Provenance[] }>();
  for (const e of rewired) {
    const key = `${e.from} ${e.to} ${edgeRelation(e)}`;
    const confRank = confidenceRank(elementConfidence(e));
    const prov = readProvenance(e);
    const prev = edgeByKey.get(key);
    if (!prev) {
      edgeByKey.set(key, { edge: e, confRank, prov });
      continue;
    }
    const winner = confRank > prev.confRank ? e : prev.edge;
    const mergedEdgeProv = normalizeProvenance([...prev.prov, ...prov]);
    edgeByKey.set(key, {
      edge: withMergedProvenance(winner, mergedEdgeProv),
      confRank: Math.max(confRank, prev.confRank),
      prov: mergedEdgeProv,
    });
  }

  return { nodes: keptNodes, edges: [...edgeByKey.values()].map((v) => v.edge) };
}

/**
 * Unify nodes tagged `config.scanRoot: true` by different extractors into one —
 * e.g. code's `gateway_server` and manifest's `service_archrad_api` both represent
 * the single app being scanned. The most specific type (gateway) and highest
 * confidence wins the id and body; the other's edges and provenance fold in.
 */
export function unifyScanRoots(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  priority: string[],
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const roots = nodes.filter(isScanRoot);
  return collapseGroup(roots, nodes, edges, priority);
}

/**
 * Unify same-type infra nodes across extractors even when their names differ
 * (manifest's `firestore` vs code's `firestore_firebase_admin`). Skips a type
 * group entirely if any SINGLE extractor contributed more than one node of that
 * type — that's a real signal of multiple distinct instances (e.g. primary +
 * replica), and merging across extractors would risk conflating them.
 */
export function unifySingletonInfra(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  priority: string[],
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const byType = new Map<string, Record<string, unknown>[]>();
  for (const n of nodes) {
    const type = typeof n.type === 'string' ? n.type : '';
    if (!SINGLETON_INFRA_TYPES.has(type)) continue;
    (byType.get(type) ?? byType.set(type, []).get(type)!).push(n);
  }

  let curNodes = nodes;
  let curEdges = edges;
  for (const group of byType.values()) {
    if (group.length < 2) continue;
    const perExtractorSeen = new Set<string>();
    let unsafe = false;
    for (const n of group) {
      for (const extractor of new Set(readProvenance(n).map((p) => p.extractor))) {
        if (perExtractorSeen.has(extractor)) unsafe = true;
        perExtractorSeen.add(extractor);
      }
    }
    if (unsafe) continue; // a single extractor found 2+ — likely genuinely distinct instances
    const result = collapseGroup(group, curNodes, curEdges, priority);
    curNodes = result.nodes;
    curEdges = result.edges;
  }
  return { nodes: curNodes, edges: curEdges };
}

/** Remove the internal `config.scanRoot` bookkeeping tag before nodes reach the public IR. */
function stripScanRootTag(node: Record<string, unknown>): Record<string, unknown> {
  if (!isScanRoot(node)) return node;
  const { scanRoot: _scanRoot, ...rest } = node.config as Record<string, unknown>;
  return { ...node, config: rest };
}

/** File part of a provenance record's `"<relPath>:<line>"`. */
function provenanceFile(record: Provenance): string {
  const idx = record.inferred_from.lastIndexOf(':');
  return idx > 0 ? record.inferred_from.slice(0, idx) : record.inferred_from;
}

/**
 * Unify the SAME compose service declared across multiple compose files —
 * `docker-compose.yml` plus its `.dev` / `.prod` / `.test` override siblings all
 * describing one `node-app`. That is Compose's own override semantics, so the
 * duplicates are an artifact of reading each file independently, not evidence of
 * distinct components.
 *
 * Deliberately narrow: only nodes whose provenance comes exclusively from the
 * compose extractor, sharing a name, contributed by DIFFERENT files. Two services
 * with the same name in the same file cannot happen (YAML keys are unique), and
 * nodes corroborated by another extractor are left to the other passes.
 */
export function unifyComposeOverrides(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  priority: string[],
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const node of nodes) {
    const name = typeof node.name === 'string' ? node.name : '';
    if (!name) continue;
    const prov = readProvenance(node);
    if (prov.length === 0 || !prov.every((p) => p.extractor === 'compose')) continue;
    (byName.get(name) ?? byName.set(name, []).get(name)!).push(node);
  }

  let curNodes = nodes;
  let curEdges = edges;
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const files = new Set(group.flatMap((n) => readProvenance(n).map(provenanceFile)));
    if (files.size < group.length) continue; // not one-node-per-file: leave it alone
    const result = collapseGroup(group, curNodes, curEdges, priority);
    curNodes = result.nodes;
    curEdges = result.edges;
  }
  return { nodes: curNodes, edges: curEdges };
}

/**
 * Relations that all describe ONE infrastructure link at differing fidelity:
 * compose says `depends_on`, code says `dbConnection`, manifest says
 * `cacheConnection`, k8s says `connectionUrl`. They are not parallel edges.
 */
const INFRA_LINK_RELATIONS = new Set([
  'depends_on',
  'dependsOn',
  'dbConnection',
  'cacheConnection',
  'connectionUrl',
  'queue',
  'smtp',
]);

/**
 * Canonical relation for an infra link, derived from what the TARGET actually is.
 * Extractors disagree on naming (code calls a Redis link `dbConnection`, manifest
 * calls it `cacheConnection`); the target's type is the objective tiebreaker.
 */
function canonicalInfraRelation(targetType: string, present: Set<string>): string {
  const t = String(targetType ?? '').toLowerCase();
  if (t === 'cache') return 'cacheConnection';
  if (t === 'smtp') return 'smtp';
  if (isQueueLikeNodeType(t)) return 'queue';
  if (isDbLikeType(t)) return 'dbConnection';
  // Unknown target: keep the most specific relation we were given.
  for (const r of ['dbConnection', 'cacheConnection', 'queue', 'smtp', 'connectionUrl']) {
    if (present.has(r)) return r;
  }
  return 'depends_on';
}

/**
 * Collapse parallel edges between the same pair that merely restate one infra
 * link. Only groups whose relations are ALL in {@link INFRA_LINK_RELATIONS} are
 * touched — `routes`, `serviceCall`, and `authMiddleware` can legitimately run in
 * parallel with a data link and are left alone.
 */
export function unifyRedundantEdges(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
): Record<string, unknown>[] {
  const typeById = new Map<string, string>();
  for (const n of nodes) {
    if (typeof n.id === 'string') typeById.set(n.id, typeof n.type === 'string' ? n.type : '');
  }

  const groups = new Map<string, Record<string, unknown>[]>();
  for (const e of edges) {
    const key = `${String(e.from)} ${String(e.to)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }

  const collapsedByKey = new Map<string, Record<string, unknown>>();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const relations = new Set(group.map(edgeRelation));
    if (![...relations].every((r) => INFRA_LINK_RELATIONS.has(r))) continue;

    const ranked = [...group].sort(
      (a, b) => confidenceRank(elementConfidence(b)) - confidenceRank(elementConfidence(a)),
    );
    const survivor = ranked[0]!;
    const mergedProv = normalizeProvenance(group.flatMap(readProvenance));
    const targetType = typeById.get(String(survivor.to)) ?? '';
    const metadata =
      survivor.metadata && typeof survivor.metadata === 'object' && !Array.isArray(survivor.metadata)
        ? (survivor.metadata as Record<string, unknown>)
        : {};
    collapsedByKey.set(key, {
      ...withMergedProvenance(survivor, mergedProv),
      metadata: { ...metadata, relation: canonicalInfraRelation(targetType, relations) },
    });
  }

  if (collapsedByKey.size === 0) return edges;

  const emitted = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const e of edges) {
    const key = `${String(e.from)} ${String(e.to)}`;
    const collapsed = collapsedByKey.get(key);
    if (!collapsed) {
      result.push(e);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.push(collapsed);
  }
  return result;
}

/**
 * Run the post-merge unification passes, in order, then strip internal tags.
 * Compose overrides collapse FIRST so the surviving service (which may carry the
 * `scanRoot` tag from its `build:` declaration) is the one offered to
 * `unifyScanRoots`.
 */
export function unifyDraft(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  priority: string[],
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const afterOverrides = unifyComposeOverrides(nodes, edges, priority);
  const afterRoots = unifyScanRoots(afterOverrides.nodes, afterOverrides.edges, priority);
  const afterInfra = unifySingletonInfra(afterRoots.nodes, afterRoots.edges, priority);
  // Edge de-duplication runs last: node unification is what makes parallel infra
  // links land on the same (from, to) pair in the first place.
  const dedupedEdges = unifyRedundantEdges(afterInfra.nodes, afterInfra.edges);
  return { nodes: afterInfra.nodes.map(stripScanRootTag), edges: dedupedEdges };
}
