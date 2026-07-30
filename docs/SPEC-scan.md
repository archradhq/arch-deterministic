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

### 6.1 Post-merge unification (`unifyDraft`)

`mergeDraftFragments` only unions nodes that already share an exact `id`. Two
real cases need a looser equivalence, run as a second pass (`unifyDraft()` in
`merge-draft.ts`, called from `scan.ts` right after the id-based merge):

- **`unifyScanRoots`** — extractors that only ever describe ONE whole-scanned-unit
  node tag it `config.scanRoot: true` (manifest, for a `package.json` directly at
  the scan root; code, for the single non-worker node `reconstructIrFromCodebase`
  produces with `singleService: true`). Any two `scanRoot`-tagged nodes are
  collapsed to one: highest confidence wins, ties broken by **type specificity**
  (`gateway` > `worker` > everything else) so a more informative classification
  isn't discarded for a generic one, then by extractor priority. `compose` never
  tags anything `scanRoot` — it can legitimately declare multiple real services, so
  nothing in it is safe to assume is "the" root.
- **`unifySingletonInfra`** — same-`type` nodes (postgres, mysql, mongodb,
  cassandra, sqlserver, search, smtp, firestore, cache — types that realistically
  have one instance per scanned unit) are collapsed across extractors even when
  their **names** differ, e.g. manifest's `firestore` vs code's
  `firestore_firebase_admin`. Guarded: a type group is left untouched if any
  *single* extractor contributed more than one node of that type — that's a real
  signal of genuinely distinct instances (primary + replica), and merging across
  extractors would risk guessing which one a different tier's finding matches.

Both operations share one mechanism (`collapseGroup`): pick the best node in the
group as the survivor, rewire every edge endpoint referencing a collapsed node
onto the survivor, union provenance, and re-dedupe any edges that collide as a
result of the rewiring. The `scanRoot` tag itself is stripped from `config` before
the draft IR is emitted — it's internal bookkeeping, not part of the public
contract.

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

1. ✅ **Infra + `compose` extractor** — plugin interface, file tree, provenance
   annotation, `mergeDraftFragments`, CLI wiring, `compose` reusing
   `dockerComposeToCanonicalIr()`.
2. ✅ `openapi` extractor — reuses `openApiStringToCanonicalIr()`; keeps engine
   route-based ids (endpoints don't collide with other tiers).
3. ✅ `manifest` extractor — hand-maintained driver-lib → infra map (no new dep);
   `package.json` + `requirements.txt`.
4. ✅ `code` extractor — wraps `reconstructIrFromCodebase()` with `singleService`
   so a monolith reads as one service; artifact-based provenance.

## 11. Open questions / follow-ups

Resolved:
- **Node-id namespacing across extractors** — resolved via `scanNodeId(kind, name)`,
  which all extractors route ids through. Infra with canonical names (postgres,
  cache_redis) now merges across compose/manifest/code.
- **App/infra id alignment across manifest + code** — resolved via a post-merge
  `unifyDraft()` pass in `merge-draft.ts` (§6.1 below). On the real repo that
  surfaced both cases: `gateway_server` (code) + `service_archrad_api` (manifest)
  now collapse to one `gateway_server` node; `firestore` (manifest) +
  `firestore_firebase_admin` (code) now collapse to one `firestore` node. Both
  carry unioned provenance from both extractors.

  **Still partial**: this only reconciles **manifest ↔ code**. `compose` is
  deliberately never tagged as a unification candidate — a compose file can
  legitimately declare multiple real services, so nothing in it is safe to assume
  is "the" root the way a root-level `package.json` or a `singleService` code scan
  is. The `compose-and-manifest` fixture's `gateway_api` / `service_api` pair is
  the documented case that still does NOT merge, and shouldn't without a more
  deliberate design (e.g. compose explicitly marking which of its services is the
  scan's entry point).

Still open (tracked here, not blocking):
- **Manifest tier is npm/pip only.** Extend `lib-map.ts` + `manifest.ts` to
  `go.mod`, `pom.xml`/Gradle, and `pyproject.toml` (TOML has no parser dep in this
  package today — regex-extract the dependency arrays, or add a parser only with
  sign-off). Each new ecosystem is additive and low-risk.
- **Fixtures dir location** — using `fixtures/scan/` to match the repo; the
  CLAUDE.md text says `tests/fixtures/` (generic). Flagging the deviation.
