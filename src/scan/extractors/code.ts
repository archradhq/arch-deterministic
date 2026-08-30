/**
 * Code extractor: shallow source analysis → PartialIR (confidence: low).
 *
 * Wraps the existing regex-based `reconstructIrFromCodebase()` engine (Node/TS,
 * Python, C#). This is the LEAST reliable tier — it pattern-matches source text,
 * it does not understand code — so everything it emits is `low` confidence.
 *
 * The reconstruct IR does not carry per-node source lines, but its `artifacts[]`
 * do; {@link pickArtifact} maps each node back to a representative artifact so
 * provenance still cites a real `file:line` instead of a bare extractor tag.
 *
 * Node ids are canonicalized so infra nodes (postgres, redis, …) can merge with
 * the compose/manifest tiers when their names align — see docs/SPEC-scan.md §11
 * for why that alignment is only partial.
 */

import { basename } from 'node:path';
import type { Extractor, PartialIR } from '../types.js';
import { canonicalizeIds } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import { reconstructIrFromCodebase, dbNodeType } from '../../reconstruct/reconstruct.js';
import type { DetectedArtifact } from '../../reconstruct/types.js';

const DATASTORE_TYPES = new Set([
  'postgres',
  'mysql',
  'mongodb',
  'cassandra',
  'sqlserver',
  'search',
  'smtp',
  'firestore',
  'cache',
]);

const SUPPORTED_SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|cs)$/i;

function rootPackageAliases(tree: Parameters<Extractor['extract']>[0]): string[] {
  const file = tree.files.find((candidate) => candidate.relPath === 'package.json');
  if (!file) return [];
  try {
    const parsed = JSON.parse(tree.read(file.relPath)) as Record<string, unknown>;
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return [];
    const unscoped = parsed.name.trim().replace(/^@[^/]+\//, '').toLowerCase();
    const semantic = unscoped.replace(/[-_.](?:monorepo|repository|repo)$/, '');
    return [...new Set([unscoped, semantic].filter(Boolean))].sort();
  } catch {
    return [];
  }
}

/** Pick the artifact that best explains a node, for provenance file:line. */
export function pickArtifact(
  node: Record<string, unknown>,
  artifacts: DetectedArtifact[],
): DetectedArtifact | undefined {
  const type = typeof node.type === 'string' ? node.type : '';
  const id = typeof node.id === 'string' ? node.id : '';

  if (DATASTORE_TYPES.has(type)) {
    // Match the db_connection artifact whose OWN inferred type equals this
    // node's type — several distinct datastores can appear in one codebase, and
    // taking the first db_connection artifact overall would misattribute every
    // node's provenance to whichever connection happened to be detected first.
    const dbArtifacts = artifacts.filter((a) => a.kind === 'db_connection');
    return dbArtifacts.find((a) => dbNodeType(a.detail) === type) ?? dbArtifacts[0];
  }
  if (type === 'auth') return artifacts.find((a) => a.kind === 'auth_middleware');
  if (type === 'worker') return artifacts.find((a) => a.kind === 'worker_definition');
  if (type === 'service' && (id.startsWith('ext_') || id.startsWith('svc_ext'))) {
    // Multiple external destinations (stripe, github, …) can appear in one
    // codebase — match by destination (reconstruct names the node after it) so
    // each external-service node cites its own call site, not the first one found.
    const name = typeof node.name === 'string' ? node.name : '';
    const extArtifacts = artifacts.filter((a) => a.kind === 'external_http' || a.kind === 'service_call');
    return extArtifacts.find((a) => a.destination === name) ?? extArtifacts[0];
  }
  // gateway / primary service node
  return (
    artifacts.find((a) => a.kind === 'app_entry') ??
    artifacts.find((a) => a.kind === 'http_route' || a.kind === 'health_route') ??
    artifacts[0]
  );
}

export const codeExtractor: Extractor = {
  name: 'code',
  defaultConfidence: 'low',
  async extract(tree): Promise<PartialIR[]> {
    // Auto-detection defaults an otherwise unknown repository to Node.js. Avoid
    // invoking reconstruction when the scan tree contains no supported source
    // files; deployment-only repositories should not receive a misleading
    // "No nodejs files" warning.
    if (!tree.files.some((file) => SUPPORTED_SOURCE_FILE.test(file.relPath))) {
      return [{ extractor: 'code', nodes: [], edges: [], warnings: [] }];
    }
    const warnings: string[] = [];
    let result;
    try {
      // singleService: a monolith's many route modules should read as ONE service
      // in the draft, not dozens of separate service nodes.
      result = await reconstructIrFromCodebase({ from: tree.root, language: 'auto', singleService: true });
    } catch (e) {
      return [
        {
          extractor: 'code',
          nodes: [],
          edges: [],
          warnings: [`${basename(tree.root)}: code analysis failed: ${e instanceof Error ? e.message : String(e)}`],
        },
      ];
    }
    warnings.push(...result.warnings);

    // reconstruct always emits a fallback service node for the root dir, even when
    // no code signal exists. Suppress that phantom: only contribute when at least
    // one artifact was actually detected.
    if (result.artifacts.length === 0) {
      return [{ extractor: 'code', nodes: [], edges: [], warnings }];
    }

    const graph = (result.ir.graph ?? result.ir) as Record<string, unknown>;
    const rawNodes = (Array.isArray(graph.nodes) ? graph.nodes : []) as Record<string, unknown>[];
    const rawEdges = (Array.isArray(graph.edges) ? graph.edges : []) as Record<string, unknown>[];

    if (rawNodes.length === 0) {
      return [{ extractor: 'code', nodes: [], edges: [], warnings }];
    }
    const packageAliases = rootPackageAliases(tree);

    // Compute provenance per original node id, then attach; canonicalize last.
    const provByNodeId = new Map<string, ReturnType<typeof provenanceEntry>>();
    const nodes = rawNodes.map((n) => {
      const id = typeof n.id === 'string' ? n.id : '';
      const art = pickArtifact(n, result.artifacts);
      const entry = provenanceEntry('code', art?.file ?? result.serviceName, art?.line, 'low');
      if (id) provByNodeId.set(id, entry);
      let tagged = withProvenance(n, entry);
      // With singleService:true, exactly one non-worker node represents the whole
      // scanned unit (name === serviceName) — mark it so the orchestrator can unify
      // it with another extractor's root node for the same scan (see merge-draft.ts
      // unifyScanRoots). Only that one node gets tagged; decomposed sub-services
      // never do.
      if (n.type !== 'worker' && n.name === result.serviceName) {
        const config =
          tagged.config && typeof tagged.config === 'object' && !Array.isArray(tagged.config)
            ? (tagged.config as Record<string, unknown>)
            : {};
        tagged = {
          ...tagged,
          config: {
            ...config,
            scanRoot: true,
            ...(packageAliases.length ? { scanAliases: packageAliases } : {}),
          },
        };
      }
      return tagged;
    });
    const edges = rawEdges.map((e) => {
      const from = typeof e.from === 'string' ? e.from : '';
      const entry =
        provByNodeId.get(from) ?? provenanceEntry('code', result.serviceName, undefined, 'low');
      return withProvenance(e, entry);
    });

    const canon = canonicalizeIds(nodes, edges);
    return [{ extractor: 'code', nodes: canon.nodes, edges: canon.edges, warnings }];
  },
};
