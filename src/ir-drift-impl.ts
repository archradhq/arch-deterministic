/**
 * IR-DRIFT-IMPL-* — compare an authored IR against a reconstructed one.
 * Surfaces discrepancies between the design contract and the actual codebase.
 */

import type { IrStructuralFinding } from './ir-structural.js';
import { buildParsedLintGraph, isParsedLintGraph } from './lint-graph.js';
import {
  isDbLikeType,
  isHttpLikeType,
  isAuthLikeNodeType,
  isHttpEndpointType,
  isQueueLikeNodeType,
  isInfraLeafSinkLintType,
} from './graphPredicates.js';
import type { ReconstructResult } from './reconstruct/types.js';

const LAYER = 'impl-drift' as const;

function finding(
  code: string,
  severity: IrStructuralFinding['severity'],
  message: string,
  extras?: Partial<IrStructuralFinding>,
): IrStructuralFinding {
  return {
    code,
    severity,
    message,
    layer: LAYER as IrStructuralFinding['layer'],
    ...extras,
  };
}

// ---- helpers to inspect authored IR ----------------------------------------

type NodeMap = Map<string, Record<string, unknown>>;

function nodeType(n: Record<string, unknown>): string {
  return String(n.type ?? n.kind ?? '').toLowerCase();
}

function extractNodes(ir: unknown): NodeMap {
  const nodes = new Map<string, Record<string, unknown>>();
  if (ir == null || typeof ir !== 'object') return nodes;
  const root = ir as Record<string, unknown>;
  const graph = (root.graph ?? root) as Record<string, unknown>;
  const arr = graph.nodes;
  if (!Array.isArray(arr)) return nodes;
  for (const n of arr) {
    if (n && typeof n === 'object' && !Array.isArray(n)) {
      const nn = n as Record<string, unknown>;
      const id = String(nn.id ?? '');
      if (id) nodes.set(id, nn);
    }
  }
  return nodes;
}

type EdgeEntry = { from: string; to: string; metadata?: Record<string, unknown> };

function extractEdges(ir: unknown): EdgeEntry[] {
  if (ir == null || typeof ir !== 'object') return [];
  const root = ir as Record<string, unknown>;
  const graph = (root.graph ?? root) as Record<string, unknown>;
  const arr = graph.edges;
  if (!Array.isArray(arr)) return [];
  const out: EdgeEntry[] = [];
  for (const e of arr) {
    if (e && typeof e === 'object') {
      const ee = e as Record<string, unknown>;
      const from = String(ee.from ?? ee.source ?? '');
      const to = String(ee.to ?? ee.target ?? '');
      if (from && to) {
        const meta = ee.metadata;
        out.push({
          from,
          to,
          metadata:
            meta && typeof meta === 'object' && !Array.isArray(meta)
              ? (meta as Record<string, unknown>)
              : undefined,
        });
      }
    }
  }
  return out;
}

/** Normalize relation/protocol tokens for comparison (`service_call` → `servicecall`). */
function normalizeEdgeToken(value: string): string {
  return value.toLowerCase().replace(/[_-\s]/g, '');
}

const DOCUMENTED_SERVICE_RELATIONS = new Set([
  'servicecall',
  'downstream',
  'outbound',
  'rpc',
  'grpc',
  'httpclient',
  'restclient',
]);

const DOCUMENTED_SERVICE_PROTOCOLS = new Set(['http', 'https', 'grpc', 'rpc']);

/**
 * True when an authored edge documents an outbound service dependency (HTTP/gRPC),
 * not incidental edges to auth, datastores, queues, infra sinks, or internal layering.
 */
function isDocumentedOutboundServiceEdge(
  edge: EdgeEntry,
  authoredNodes: NodeMap,
): boolean {
  const target = authoredNodes.get(edge.to);
  if (!target) return false;
  const t = nodeType(target);
  if (isDbLikeType(t) || isAuthLikeNodeType(t)) return false;
  if (isQueueLikeNodeType(t) || isInfraLeafSinkLintType(t)) return false;

  const relation = normalizeEdgeToken(String(edge.metadata?.relation ?? ''));
  if (relation && DOCUMENTED_SERVICE_RELATIONS.has(relation)) return true;

  const protocol = String(edge.metadata?.protocol ?? '').toLowerCase();
  if (protocol && DOCUMENTED_SERVICE_PROTOCOLS.has(protocol)) return true;

  // gRPC / REST endpoint nodes are typically remote peers, not in-process layers.
  if (t === 'grpc' || isHttpEndpointType(t)) return true;

  return false;
}

// ---- individual drift rules -------------------------------------------------

/**
 * IR-DRIFT-IMPL-001 — Authored IR has HTTP-like nodes; reconstruction found
 * zero artifacts (no routes, DB, auth, or outbound calls detected in scan).
 */
function ruleNoImpl(
  authoredNodes: NodeMap,
  reconstructed: ReconstructResult,
): IrStructuralFinding[] {
  if (reconstructed.artifacts.length > 0) return [];

  const httpNodes = [...authoredNodes.values()].filter((n) => isHttpLikeType(nodeType(n)));
  if (httpNodes.length === 0) return [];

  return [
    finding(
      'IR-DRIFT-IMPL-001',
      'warning',
      `Authored IR declares ${httpNodes.length} HTTP-like node(s) but reconstruction found no implementation in the codebase`,
      {
        fixHint:
          'Verify --codebase points to the correct service root, or update the authored IR to match the actual implementation.',
        suggestion:
          'Run `archrad reconstruct --from <path>` directly to see what the analyzer detected.',
        impact:
          'The authored IR may describe a service that has not yet been implemented or has been removed.',
      },
    ),
  ];
}

/**
 * IR-DRIFT-IMPL-002 — Reconstruction found artifacts but the authored IR has
 * no nodes of corresponding types (undocumented service).
 */
function ruleUndocumentedImpl(
  authoredNodes: NodeMap,
  reconstructed: ReconstructResult,
): IrStructuralFinding[] {
  const findings: IrStructuralFinding[] = [];
  const authoredTypes = new Set([...authoredNodes.values()].map((n) => nodeType(n)));

  const httpArtifacts = reconstructed.artifacts.filter((a) => a.kind === 'http_route');
  const hasHttpInCode = reconstructed.artifacts.some(
    (a) => a.kind === 'http_route' || a.kind === 'health_route',
  );
  const hasHttpInIr = [...authoredTypes].some((t) => isHttpLikeType(t));

  // IR-DRIFT-IMPL-004 covers undocumented HTTP entry points (error severity).
  if (httpArtifacts.length > 0 && !hasHttpInIr) {
    return [];
  }

  if (hasHttpInCode && !hasHttpInIr) {
    findings.push(
      finding(
        'IR-DRIFT-IMPL-002',
        'warning',
        'HTTP routes found in codebase but no HTTP-like nodes exist in the authored IR',
        {
          fixHint:
            'Add HTTP node(s) to the authored IR to document the service entry points.',
          suggestion:
            'Use `archrad reconstruct --from <path> --output reconstructed.json` then merge the missing nodes.',
          impact:
            'The authored IR does not reflect real service entry points — reviewers and validators are working from an incomplete picture.',
        },
      ),
    );
  }

  return findings;
}

/**
 * IR-DRIFT-IMPL-003 — Direct database connection found in code but no DB
 * edges exist in the authored IR.
 * CRITICAL: catches the "dummy IR" attack.
 */
function ruleDirectDbNotInIr(
  authoredNodes: NodeMap,
  authoredEdges: EdgeEntry[],
  reconstructed: ReconstructResult,
): IrStructuralFinding[] {
  const dbArtifacts = reconstructed.artifacts.filter((a) => a.kind === 'db_connection');
  if (dbArtifacts.length === 0) return [];

  // Does the authored IR have ANY edge where the target node is DB-like?
  const authoredDbEdges = authoredEdges.filter((e) => {
    const targetNode = authoredNodes.get(e.to);
    return targetNode !== undefined && isDbLikeType(nodeType(targetNode));
  });

  if (authoredDbEdges.length > 0) return [];

  const dbTypes = [...new Set(dbArtifacts.map((a) => a.detail.split('→').pop()?.trim() ?? ''))].join(
    ', ',
  );
  return [
    finding(
      'IR-DRIFT-IMPL-003',
      'error',
      `Direct database connection(s) detected in code (${dbTypes}) but no DB edges exist in the authored IR`,
      {
        fixHint:
          'Either add the missing DB edges to the authored IR, or confirm the codebase points to the correct service.',
        suggestion:
          'This discrepancy is a governance red flag: the authored IR could be masking a direct DB dependency. Review the detected files and reconcile the IR.',
        impact:
          'CRITICAL — this pattern is exploited in "dummy IR" attacks where clean design docs conceal direct database access in shipped code.',
      },
    ),
  ];
}

/**
 * IR-DRIFT-IMPL-004 — HTTP routes found in code but no HTTP entry nodes in
 * the authored IR.
 * (More specific variant of 002 when the authored IR has NO http nodes at all.)
 */
function ruleHttpNotInIr(
  authoredNodes: NodeMap,
  reconstructed: ReconstructResult,
): IrStructuralFinding[] {
  const httpArtifacts = reconstructed.artifacts.filter((a) => a.kind === 'http_route');
  if (httpArtifacts.length === 0) return [];

  const authoredHasHttp = [...authoredNodes.values()].some((n) => isHttpLikeType(nodeType(n)));
  if (authoredHasHttp) return [];

  const sample = httpArtifacts
    .slice(0, 3)
    .map((a) => a.detail)
    .join(', ');
  return [
    finding(
      'IR-DRIFT-IMPL-004',
      'error',
      `HTTP entry point(s) found in code not present in the authored IR (e.g. ${sample})`,
      {
        fixHint: 'Add HTTP node(s) to the authored IR matching the detected routes.',
        suggestion:
          'Run `archrad reconstruct --from <path> --output reconstructed.json` to generate a starting point.',
        impact:
          'Undocumented entry points bypass architectural review and may lack auth, rate-limiting, or observability coverage.',
      },
    ),
  ];
}

/**
 * IR-DRIFT-IMPL-005 — Service-to-service HTTP/gRPC calls detected in code
 * with no corresponding edges in the authored IR.
 */
function ruleServiceCallNotInIr(
  authoredNodes: NodeMap,
  authoredEdges: EdgeEntry[],
  reconstructed: ReconstructResult,
): IrStructuralFinding[] {
  const callArtifacts = reconstructed.artifacts.filter((a) => a.kind === 'service_call');
  if (callArtifacts.length === 0) return [];

  const hasDocumentedServiceCalls = authoredEdges.some((e) =>
    isDocumentedOutboundServiceEdge(e, authoredNodes),
  );

  if (hasDocumentedServiceCalls) return [];

  return [
    finding(
      'IR-DRIFT-IMPL-005',
      'warning',
      'Service-to-service HTTP/gRPC calls detected in code but no corresponding edges in the authored IR',
      {
        fixHint:
          'Add downstream service nodes and edges in the authored IR for each detected outbound call.',
        suggestion:
          'Capture service dependencies in the IR so they appear in architecture reviews and drift checks.',
        impact:
          'Hidden downstream dependencies increase operational risk and complicate incident response.',
      },
    ),
  ];
}

/**
 * IR-DRIFT-IMPL-006 — Auth middleware found in code but no auth-like node in
 * the authored IR neighbourhood.
 * Severity: info — the implementation is MORE secure than the authored design suggests.
 */
function ruleAuthInCodeNotInIr(
  authoredNodes: NodeMap,
  reconstructed: ReconstructResult,
): IrStructuralFinding[] {
  const authArtifacts = reconstructed.artifacts.filter((a) => a.kind === 'auth_middleware');
  if (authArtifacts.length === 0) return [];

  const authoredHasAuth = [...authoredNodes.values()].some((n) => isAuthLikeNodeType(nodeType(n)));
  if (authoredHasAuth) return [];

  return [
    finding(
      'IR-DRIFT-IMPL-006',
      'info',
      `Auth middleware detected in code (${authArtifacts[0]?.detail ?? ''}) but no auth node in the authored IR`,
      {
        fixHint:
          'Add an auth/middleware node to the authored IR to document the auth boundary.',
        suggestion:
          'The implementation is already doing the right thing — the authored IR just does not reflect it. Adding the node enables IR-LINT-MISSING-AUTH-010 to pass cleanly.',
        impact:
          'Positive: auth is enforced in code. The IR underrepresents the security posture.',
      },
    ),
  ];
}

// ---- public entry point -----------------------------------------------------

export function compareImplementationDrift(
  authoredIr: unknown,
  reconstructed: ReconstructResult,
): IrStructuralFinding[] {
  // Quick guard: if the authored IR can't be parsed by the lint graph builder,
  // fall back to an empty comparison rather than crashing.
  const built = buildParsedLintGraph(authoredIr);
  if (!isParsedLintGraph(built)) {
    return [
      finding(
        'IR-DRIFT-IMPL-000',
        'warning',
        'Could not parse the authored IR for implementation drift comparison — fix IR-STRUCT-* issues (or run `archrad validate` without `--codebase`) before comparing to the codebase.',
      ),
    ];
  }

  const authoredNodes = extractNodes(authoredIr);
  const authoredEdges = extractEdges(authoredIr);

  return [
    ...ruleNoImpl(authoredNodes, reconstructed),
    ...ruleUndocumentedImpl(authoredNodes, reconstructed),
    ...ruleDirectDbNotInIr(authoredNodes, authoredEdges, reconstructed),
    ...ruleHttpNotInIr(authoredNodes, reconstructed),
    ...ruleServiceCallNotInIr(authoredNodes, authoredEdges, reconstructed),
    ...ruleAuthInCodeNotInIr(authoredNodes, reconstructed),
  ];
}
