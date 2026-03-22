# IR contract: parser boundary and validation levels

## External input (parser boundary)

The toolchain accepts **either**:

- `{ "graph": { ... } }` — product / wrapped shape, or  
- A **bare graph** object with top-level `nodes` (and optional `edges`, `metadata`).

`normalizeIrGraph(ir)` returns a single internal **`graph`** object in both cases.

## Internal normalized graph (after unwrap)

Always:

- `graph.metadata` — object (default `{}` if missing or invalid)
- `graph.nodes` — array (required for export; validated separately)
- `graph.edges` — array or absent; non-array `edges` is treated as `[]` with a structural **warning**

`materializeNormalizedGraph(graph)` builds the **coerced** view used by structural validation and architecture lint (generators still receive the **original** IR).

## Internal normalized node

| Field    | Meaning |
|----------|---------|
| `id`     | string (trimmed from `id`) |
| `type`   | string, lowercased from `type` **or** `kind` |
| `name`   | string |
| `config` | object (empty if missing / non-object) |
| `schema` | object (empty if missing / non-object) |

## Internal normalized edge

| Field    | Meaning |
|----------|---------|
| `id`     | string |
| `from`   | string, from `from` **or** `source` |
| `to`     | string, from `to` **or** `target` |
| `config` | object (empty if missing / non-object) |
| `metadata` | object (preserved for lint, e.g. `protocol: async`, `kind` from top-level **`edge.kind`** when `metadata.kind` is unset; empty if missing) |

**Index contract:** `materializeNormalizedGraph` maps **`graph.edges[i]` → `normalized.edges[i]`** 1:1 when `edges` is an array; structural findings reference `edgeIndex` in that array.

API: `materializeNormalizedGraph`, `normalizeNodeSlot`, `normalizeEdgeSlot` in `src/ir-normalize.ts` (re-exported from the package entry).

## Validation levels (contract for developers)

1. **JSON Schema validation** — Document contract: `schemas/archrad-ir-graph-v1.schema.json`. Use in editors, CI, or with a schema validator; this package does not require Ajv at runtime for export.
2. **IR structural validation** — Runtime checks in `validateIrStructural`: nodes array, unique ids (edges referencing **duplicate** ids get **`IR-STRUCT-EDGE_AMBIGUOUS_*`**), **HTTP-like** node types (shared predicate with lint: `http`, `rest`, `gateway`, …), `config` path/method, edge endpoints, directed cycles (cycle message includes an example node id). Codes: **`IR-STRUCT-*`**.
3. **Export-time OpenAPI structural validation** — After codegen, **`validateOpenApiInBundleStructural`** (parse + required OpenAPI document fields). Not Spectral-level API lint.

Between (2) and (3), **architecture lint** (`IR-LINT-*`) runs on a parsed graph from the normalized shape; it is heuristic, not JSON Schema. **`validateIrLint`** returns **`IR-STRUCT-*`** when the IR cannot be normalized (same as `normalizeIrGraph`); **`runDeterministicExport`** folds those into **`irStructuralFindings`** if structural validation was skipped so exports still fail closed on invalid roots / empty graphs.

See also [STRUCTURAL_VS_SEMANTIC_VALIDATION.md](./STRUCTURAL_VS_SEMANTIC_VALIDATION.md).
