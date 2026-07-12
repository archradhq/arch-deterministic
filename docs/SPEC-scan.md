# SPEC — `archrad scan`

Status: **draft** · Owner: deterministic package · Last updated: 2026-07-10

## 1. Purpose

`archrad scan` points at a repository and produces a **draft IR** by statically
analyzing structural signals. The human then reviews and approves the draft.
The design goal is **"confirm/edit," never "author from scratch."**

This is distinct from the existing subcommands, which each cover exactly one
signal source. `scan` is the **orchestrator** that runs several extractors over
one repo, annotates every node/edge with provenance + confidence, and merges the
results into a single draft IR.

## 2. Non-negotiable principles

- **Deterministic.** No LLM calls, no network calls, no probabilistic inference
  at scan time. Same repo in → byte-identical IR out. (Consistent with the
  package's core principle.)
- **Static only.** File parsing and regex/AST signal extraction. Never semantic
  analysis of business logic.
- **Provenance always.** Every inferred node and edge carries
  `inferred_from: "<relative-file>:<line>"` and a `confidence` score.
- **Draft-marked output.** The emitted graph carries `metadata.status: "draft"`.

## 3. Reuse map (do not reimplement)

`scan` wraps existing, tested converters rather than duplicating parsing:

| Extractor | Signal source | Existing code to reuse | Confidence |
|-----------|---------------|------------------------|------------|
| `compose`  | `docker-compose.yml`, `compose.yaml` | `src/init/docker-compose.ts` → `dockerComposeToCanonicalIr()` | **high** |
| `openapi`  | `openapi.{json,yaml}`, `swagger.*` | `src/openapi-to-ir.ts` → `openApiStringToCanonicalIr()` | **medium** |
| `manifest` | `package.json`, `go.mod`, `requirements.txt`, `pyproject.toml`, `pom.xml` | *new* (client lib → edge table) | **low** |
| `code`     | import graph, routes, DB conn strings | `src/reconstruct/reconstruct.ts` → `reconstructIrFromCodebase()` | **low** |

Merging reuses the shape of `src/fragment/merge.ts` but requires a new
confidence-aware policy (see §6) — the existing `mergeIrFragments()` **errors on
node-id conflicts**, whereas scan must **resolve** them by confidence.

Priority order for confidence assignment (per project spec):
topology > interface def > manifest imports > shallow code.

## 4. Architecture

```
scan(path, opts)
  ├─ buildFileTree(path)                 // deterministic, sorted, respects excludes
  ├─ for each enabled Extractor:
  │      extractor(fileTree) -> PartialIR[]   // pure function
  ├─ annotateProvenance(PartialIR[])     // ensure inferred_from + confidence on every node/edge
  ├─ mergeDraft(PartialIR[])             // confidence-aware union (§6)
  └─ emit IR { graph: { metadata: { status: "draft", ... }, nodes, edges } }
```

### 4.1 Extractor plugin interface

```ts
export type Confidence = 'high' | 'medium' | 'low';

export type ScanFile = {
  /** POSIX-normalized path relative to scan root. */
  relPath: string;
  /** Absolute path (for readers that need it). */
  absPath: string;
};

export type ScanFileTree = {
  root: string;              // absolute scan root
  files: ScanFile[];         // sorted by relPath for determinism
  read(relPath: string): string;  // utf8, cached
};

export type Provenance = {
  inferred_from: string;     // "<relPath>:<line>" (line 1 if line unknown)
  confidence: Confidence;
  extractor: string;         // extractor name, e.g. "compose"
};

/** A node/edge fragment that carries provenance in `config.provenance`. */
export type PartialIR = {
  extractor: string;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  warnings?: string[];
};

/** Pure: no I/O beyond `tree.read`, no clock, no network. */
export type Extractor = {
  name: string;
  defaultConfidence: Confidence;
  extract(tree: ScanFileTree): PartialIR[];
};
```

Provenance is attached under each node/edge's `config.provenance` (array,
because a merged element may have several sources). The schema permits this —
`node.config`/`edge.config` are open objects (`additionalProperties: true`).

## 5. Provenance annotation

For every node and edge a `PartialIR` produces, `annotateProvenance` ensures:

```jsonc
"config": {
  "provenance": [
    { "inferred_from": "docker-compose.yml:12", "confidence": "high", "extractor": "compose" }
  ]
}
```

- Extractors that already know the source line set it; otherwise line `1`.
- Confidence defaults to the extractor's `defaultConfidence` unless the
  extractor overrides per element (e.g. an explicit `depends_on` edge may be
  `high` while an inferred one is `medium`).

## 6. Merge rule (confidence-aware)

Union on `node.id`. When the same id is produced by multiple extractors:

1. **Keep the definition with the highest confidence** (`high > medium > low`).
   Ties broken by extractor priority order (compose > openapi > manifest > code),
   then lexical extractor name — fully deterministic.
2. **Union all `provenance` entries** onto the winning node (sorted, deduped).
3. Edges: union on `(from, to, relation)`; keep highest confidence, union
   provenance. Drop edges whose endpoints didn't survive, emitting a warning.

This differs from `mergeIrFragments()` (which throws `FragmentMergeConflictError`).
`scan` never errors on overlap — overlap is the expected/desired signal that two
sources agree. Implement as a new `mergeDraftFragments()` in
`src/scan/merge-draft.ts`; factor shared helpers (`getGraph`, fingerprinting,
`sortKeysDeep`) out of `fragment/merge.ts` if practical, else duplicate minimally.

## 7. Output contract

```jsonc
{
  "graph": {
    "metadata": {
      "name": "<root dir name>",
      "status": "draft",
      "provenance": {
        "source": "scan",
        "extractors": ["compose", "openapi"],
        "fileCount": 42
      }
    },
    "nodes": [ /* each with config.provenance[] */ ],
    "edges": [ /* each with config.provenance[] */ ]
  }
}
```

- Serialized with the package's canonical JSON writer (stable key order, trailing
  newline) so output is byte-stable.
- Passes `validateIrStructural()`.

## 8. CLI

```
archrad scan [path]
  --out <file>            Write draft IR JSON (default: stdout)
  --extractors <list>     Comma list to enable (default: all). e.g. compose,openapi
  --exclude <pattern>     Path fragment to exclude (repeatable)
  --dry-run               Print to stdout, write nothing
  --verbose               Print per-extractor node/edge/warning counts to stderr
```

- `path` defaults to `.`.
- Unknown extractor name → error listing valid names, exit 1.
- Conventions mirror the existing `reconstruct` and `ingest` commands
  (option names, stderr warning prefix `archrad scan:`, exit codes).

## 9. Testing (non-negotiable)

Fixtures live in `packages/deterministic/fixtures/scan/<name>/` (repo already
uses `fixtures/`, not `tests/fixtures/`; align to the repo).

Per extractor:
- A fixture repo under `fixtures/scan/<extractor>-*/`.
- Snapshot test: fixture in → expected draft IR out, **byte-stable**.
- Provenance assertion: every node/edge has `config.provenance` with a valid
  `inferred_from` and `confidence`.

Cross-cutting:
- **Determinism test:** run `scan` twice on a fixture, assert identical bytes.
- **Merge test:** a fixture where two extractors emit the same node id; assert
  highest confidence wins and provenance is unioned.
- Do not mark a phase complete until `npm test` passes in the package.

## 10. Build order (one extractor per PR)

1. **Infra + `compose` extractor** (this is the first slice): plugin interface,
   file tree, provenance annotation, `mergeDraftFragments`, CLI wiring, and the
   `compose` extractor reusing `dockerComposeToCanonicalIr()`. Compose is chosen
   first because it is the highest-confidence source and its converter already
   exists and is tested.
2. `openapi` extractor.
3. `manifest` extractor (new client-lib → edge table; requires the dep-map
   decision — no new runtime deps without asking).
4. `code` extractor (wrap `reconstructIrFromCodebase`; reconcile its node-id
   scheme with the merger).

## 11. Open questions

- **Node-id namespacing across extractors.** Compose names a Postgres node from
  the service key; `reconstruct` names it `db_postgres_<svc>`. For merge-on-id to
  find agreement, extractors need a shared id convention for common infra
  (databases, caches, external APIs). Proposal: a canonical id helper
  `scanNodeId(kind, name)` all extractors call. Decide during slice 1.
- **Fixtures dir location** — using `fixtures/scan/` to match the repo; the
  CLAUDE.md text says `tests/fixtures/` (generic). Flagging the deviation.
```
