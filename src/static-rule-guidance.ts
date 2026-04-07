/**
 * Static, deterministic remediation text for built-in finding codes (IR-STRUCT-*, IR-LINT-*, DRIFT-*).
 * Used by MCP `archrad_suggest_fix` — not generated architecture; same hints the engine documents in findings.
 */

export type StaticRuleGuidance = {
  findingCode: string;
  title: string;
  remediation: string;
  /** Canonical docs path (no analytics/query params). */
  docsUrl: string;
};

/** Public OSS repo (subtree); `docs/` is at repo root in arch-deterministic. */
export const RULE_CODES_DOC_BASE =
  'https://github.com/archradhq/arch-deterministic/blob/main/docs/RULE_CODES.md';

/** GitHub heading anchor (must match markdown `## CODE` in docs/RULE_CODES.md). */
export function githubRuleCodeAnchor(code: string): string {
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function docsUrlForFindingCode(code: string): string {
  return `${RULE_CODES_DOC_BASE}#${githubRuleCodeAnchor(code)}`;
}

/** Built-in codes with curated guidance. Org PolicyPack codes (e.g. ORG-*) are not listed here. */
const GUIDANCE: Record<string, { title: string; remediation: string }> = {
  'IR-LINT-DIRECT-DB-ACCESS-002': {
    title: 'HTTP-like node connects directly to a datastore',
    remediation:
      'Introduce a service or domain layer between HTTP handlers and persistence: add intermediate nodes and edges so the API does not couple directly to a single DB node. This preserves testability, storage swaps, and invariant enforcement at a clear boundary.',
  },
  'IR-LINT-HIGH-FANOUT-004': {
    title: 'High outgoing dependency count',
    remediation:
      'Reduce fan-out: split responsibilities, add a facade, batch calls, or use async handoff (queues) so one node does not synchronously depend on many downstreams. High fan-out increases blast radius and latency under load.',
  },
  'IR-LINT-SYNC-CHAIN-001': {
    title: 'Long synchronous chain from HTTP entry',
    remediation:
      'Shorten the synchronous call graph or mark non-blocking hops as async: set `metadata.protocol` / edge metadata for async boundaries, or `config.async` where applicable, so depth reflects real execution. Deep sync chains amplify latency and failures.',
  },
  'IR-LINT-NO-HEALTHCHECK-003': {
    title: 'No typical health/readiness route on HTTP nodes',
    remediation:
      'Add at least one GET route such as `/health` or `/ready` on an HTTP node (or document a dedicated health node). Orchestrators and load balancers rely on these for safe deploys and rollbacks.',
  },
  'IR-LINT-ISOLATED-NODE-005': {
    title: 'Node has no incident edges',
    remediation:
      'Remove the orphan or connect it with edges so it participates in the architecture. Isolated nodes usually mean stale IR or a missing integration.',
  },
  'IR-LINT-DUPLICATE-EDGE-006': {
    title: 'Duplicate from→to edge',
    remediation:
      'Collapse duplicate edges or distinguish them with metadata if your model allows. Parallel duplicates clutter views and can double-count in generators.',
  },
  'IR-LINT-HTTP-MISSING-NAME-007': {
    title: 'HTTP-like node missing display name',
    remediation:
      'Set a short human-readable `name` on the node for docs, OpenAPI titles, and graph labels.',
  },
  'IR-LINT-DATASTORE-NO-INCOMING-008': {
    title: 'Datastore has no incoming edges',
    remediation:
      'Connect a service or data path to this datastore, or remove it if unused. Orphan persistence nodes misrepresent how data is written.',
  },
  'IR-LINT-MULTIPLE-HTTP-ENTRIES-009': {
    title: 'Multiple HTTP entry nodes without incoming edges',
    remediation:
      'Prefer a single API gateway or BFF unless multiple public surfaces are intentional and documented. Multiple entries duplicate auth, rate limits, and observability concerns.',
  },
  'IR-LINT-MISSING-AUTH-010': {
    title: 'HTTP entry missing auth coverage',
    remediation:
      'Add an auth boundary: connect an auth, oauth, jwt, or middleware node with an edge to or from this entry, or set `config.authRequired: false` for intentionally public endpoints (health, assets). Regulated environments expect a documented auth path for every public HTTP entry.',
  },
  'IR-LINT-DEAD-NODE-011': {
    title: 'Non-sink node with incoming edges but no outgoing edges',
    remediation:
      'Add an outgoing edge to a downstream consumer, or remove the node if it is obsolete. Dead-end non-sinks often indicate incomplete migrations or IR mistakes.',
  },
  'IR-STRUCT-INVALID_ROOT': {
    title: 'IR root is not a JSON object',
    remediation:
      'Pass a single JSON object: either `{ "graph": { "nodes": [], "edges": [] } }` or a graph object with a top-level `nodes` array.',
  },
  'IR-STRUCT-NO_GRAPH': {
    title: 'Missing graph shape',
    remediation:
      'Include `.graph` with `nodes` (and optional `edges`) or a top-level `nodes` array so the document describes a graph.',
  },
  'IR-STRUCT-NODES_NOT_ARRAY': {
    title: '`nodes` is not an array',
    remediation:
      'Set `nodes` to an array of node objects, each with a string `id` and a type/kind.',
  },
  'IR-STRUCT-EDGES_NOT_ARRAY': {
    title: '`edges` is present but not an array',
    remediation:
      'Set `edges` to an array of edge objects (or omit `edges` if there are no edges). Malformed `edges` is treated as empty with a warning.',
  },
  'IR-STRUCT-EMPTY_GRAPH': {
    title: 'Graph has no nodes',
    remediation:
      'Add at least one node before validation or export. An empty graph cannot generate a service.',
  },
  'IR-STRUCT-NODE_INVALID': {
    title: 'Node entry is not an object',
    remediation:
      'Each element of `nodes` must be a JSON object with at least `id` and type information.',
  },
  'IR-STRUCT-NODE_NO_ID': {
    title: 'Node missing non-empty id',
    remediation:
      'Assign a stable string `id` to every node. Ids are used for edges and code generation.',
  },
  'IR-STRUCT-DUP_NODE_ID': {
    title: 'Duplicate node id',
    remediation:
      'Ensure node ids are unique. Edges cannot reference duplicate ids unambiguously.',
  },
  'IR-STRUCT-NODE_INVALID_CONFIG': {
    title: 'Node `config` is not a plain object',
    remediation:
      'Use a plain object for `config` (e.g. `{ "url": "/api", "method": "GET" }`). Arrays and null are not valid.',
  },
  'IR-STRUCT-HTTP_PATH': {
    title: 'HTTP endpoint path invalid',
    remediation:
      'Set `config.url` or `config.route` to a non-empty path starting with `/`, e.g. `/users`.',
  },
  'IR-STRUCT-HTTP_METHOD': {
    title: 'HTTP method not supported',
    remediation:
      'Use GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS in `config.method` (default may be applied as POST).',
  },
  'IR-STRUCT-EDGE_INVALID': {
    title: 'Edge is not an object',
    remediation:
      'Each edge must be an object with `from`/`to` (or `source`/`target`) referencing node ids.',
  },
  'IR-STRUCT-EDGE_NO_ENDPOINTS': {
    title: 'Edge missing endpoints',
    remediation:
      'Set both ends of the edge to existing node ids using `from` and `to` (or legacy `source`/`target`).',
  },
  'IR-STRUCT-EDGE_AMBIGUOUS_FROM': {
    title: 'Edge references duplicate source id',
    remediation:
      'Resolve duplicate node ids first; edges cannot point to an ambiguous source.',
  },
  'IR-STRUCT-EDGE_UNKNOWN_FROM': {
    title: 'Edge references unknown source node',
    remediation:
      'Add a node with the referenced id or correct the `from` endpoint.',
  },
  'IR-STRUCT-EDGE_AMBIGUOUS_TO': {
    title: 'Edge references duplicate target id',
    remediation:
      'Resolve duplicate node ids first; edges cannot point to an ambiguous target.',
  },
  'IR-STRUCT-EDGE_UNKNOWN_TO': {
    title: 'Edge references unknown target node',
    remediation:
      'Add a node with the referenced id or correct the `to` endpoint.',
  },
  'IR-STRUCT-CYCLE': {
    title: 'Directed cycle in the graph',
    remediation:
      'Remove or break cyclic edges unless your deployment explicitly allows synchronous loops. Cycles block layering and complicate codegen assumptions.',
  },
  'DRIFT-MISSING': {
    title: 'Exported file missing on disk',
    remediation:
      'Regenerate the export (`archrad export`) or restore the missing file so the tree matches the deterministic output for this IR.',
  },
  'DRIFT-MODIFIED': {
    title: 'File differs from deterministic export',
    remediation:
      'Revert manual edits to generated files or update the IR and re-export so the on-disk tree matches the compiler output.',
  },
  'DRIFT-EXTRA': {
    title: 'Extra file not in deterministic export',
    remediation:
      'Remove stray files from the export directory or add them to the model if they should be generated. Use `--strict-extra` semantics as documented for your CI gate.',
  },
  'DRIFT-NO-EXPORT': {
    title: 'No export produced for drift comparison',
    remediation:
      'Fix IR structural/lint errors blocking export, or verify `--target` and IR content so the exporter emits files.',
  },
};

export function listStaticRuleCodes(): string[] {
  return Object.keys(GUIDANCE).sort();
}

export function getStaticRuleGuidance(findingCode: string): StaticRuleGuidance | null {
  const g = GUIDANCE[findingCode];
  if (!g) return null;
  return {
    findingCode,
    title: g.title,
    remediation: g.remediation,
    docsUrl: docsUrlForFindingCode(findingCode),
  };
}
