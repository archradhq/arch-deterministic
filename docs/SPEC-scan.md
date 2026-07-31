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
| `kubernetes` | any `.yaml`/`.yml` containing k8s manifests (detected by content, not filename) | *new* (see §3.1) — reuses `inferTypeFromImage()`, `connectionUrlHost()`, `composePlainEnvHostname()`, `CONNECTION_ENV_KEYS`, `HOST_ONLY_ENV_KEYS` from `src/init/docker-compose.ts` | **high** |
| `openapi`  | `openapi.{json,yaml}`, `swagger.*` | `src/openapi-to-ir.ts` → `openApiStringToCanonicalIr()` | **medium** |
| `terraform` | `*.tf` (HCL) | *new* — regex, not a real HCL parse (see §3.2) | **medium** |
| `manifest` | `package.json`, `go.mod`, `requirements.txt`, `pyproject.toml`, `pom.xml` | *new* (client lib → edge table) | **low** |
| `code`     | import graph, routes, DB conn strings | `src/reconstruct/reconstruct.ts` → `reconstructIrFromCodebase()` | **low** |

Merging reuses the shape of `src/fragment/merge.ts` but requires a new
confidence-aware policy (see §6) — the existing `mergeIrFragments()` **errors on
node-id conflicts**, whereas scan must **resolve** them by confidence.

Priority order for confidence assignment (per project spec):
topology > interface def > manifest imports > shallow code.

### 3.1 `kubernetes` extractor design

Unlike `compose`, k8s manifests have no fixed filename — a cluster's YAML lives
wherever a repo puts it. Detection is by **content**: any YAML document with
both `apiVersion` and a `kind` in the recognized set (`Deployment`,
`StatefulSet`, `DaemonSet`, `Pod`, `Job`, `CronJob`, `Service`, `Ingress`). Files
are parsed as multi-document YAML (`---`-separated), same as `dockerComposeToCanonicalIr`'s
own multi-doc handling.

- **Resolution is whole-tree, not per-file.** Every recognized document across
  every YAML file in the scan is parsed into one flat list *before* any
  Service/Ingress/env resolution runs. This matters because the single most
  common real-world k8s layout is one resource per file
  (`deployment.yaml`, `service.yaml`, `configmap.yaml`, `ingress.yaml` as
  siblings in the same directory) — resolving per-file would silently produce
  zero routing edges for that layout, which is worse than not trying at all
  because nothing would signal the miss. (An earlier version of this extractor
  did resolve per-file; caught and fixed before it shipped further.)
- **Workloads** (`Deployment`/`StatefulSet`/`DaemonSet`/`Pod`) → one node each.
  Type comes from the pod template's first container image via
  `inferTypeFromImage()` — the exact function `compose` uses, so a Postgres
  StatefulSet and a Postgres Compose service classify identically.
  `Job`/`CronJob` → type `worker` unconditionally (a batch job is a worker
  regardless of image, matching how BullMQ workers are typed elsewhere).
- **`Service`** is NOT its own node — it's routing, not a component. It's
  resolved to an **alias**: the workload(s) its `spec.selector` matches (by pod
  labels), across the whole scan. Anything that references the Service's DNS
  name resolves to that workload, mirroring how `compose` treats a service key
  as a hostname.
- **`Ingress`** → a `gateway` node, with edges to the backend Services (resolved
  to their workloads) named in `spec.rules[].http.paths[].backend.service.name`
  (or the older `backend.serviceName`), across the whole scan.
- **Connections**: a workload's env vars are checked against the same
  `CONNECTION_ENV_KEYS` / `HOST_ONLY_ENV_KEYS` constants and
  `connectionUrlHost()` / `composePlainEnvHostname()` helpers `compose` uses —
  if the resolved host matches another Service's DNS name (short name before
  the first `.`) or a workload name directly, an edge is added.
- **`valueFrom.configMapKeyRef`** is resolved when the referenced `ConfigMap`
  is present anywhere in the scan and has a literal `data`/`stringData` value
  for that key — ConfigMaps aren't secret, so real GitOps repos commonly commit
  their actual values.
- **`valueFrom.secretKeyRef`** is deliberately NOT resolved — a `Secret`'s
  `data` is base64, and in a properly secured repo the real value lives in an
  external secret manager, not git, so even reading it would usually yield
  nothing real. Silently skipping it would be a **silent miss** (the SPEC's
  worst outcome), so instead: a connection-shaped env var wired through
  `secretKeyRef` produces an explicit **warning** naming the workload and key —
  "connection likely present here, but not detectable" beats no signal at all.

### 3.2 `terraform` extractor design

Terraform is HCL, not YAML/JSON — `js-yaml` cannot parse it, and adding a real
HCL parser is a new runtime dependency (against the "ask before adding any new
dependency" rule). This extractor deliberately takes the **regex** path instead,
matching how the `code` extractor already treats source text: no new
dependency, at the cost of being less reliable than a real parse. That's why
its confidence is **medium**, not `compose`/`kubernetes`'s `high` — a
`resource` block is a real declaration, but regex-over-HCL can be fooled by a
`count = 0` (disabled resource), a commented-out block, or a resource type it
doesn't recognize.

- **Detection:** any `*.tf` file; naive brace-counting to isolate each
  `resource "<type>" "<name>" { ... }` block's body (accepts the rare
  false-split from a brace inside a string literal — a known, documented
  corner case, not silently perfect).
- **Node mapping:** a fixed lookup table (`terraform-resource-map.ts`, same
  shape as `lib-map.ts`) maps recognized `resource` types across AWS/GCP/Azure
  to an IR node type — `aws_db_instance` → `postgres`, `google_pubsub_topic` →
  `queue`, `google_cloud_run_service` → `service`, etc. Node id via
  `scanNodeId(irType, localName)`, same canonicalization as every other tier —
  so the SAME Postgres declared in both Terraform and a hybrid repo's
  `docker-compose.yml` still merges. Unrecognized resource types are skipped
  (no node), same "quiet skip" policy as `manifest`.
- **Edges:** within a block's body, scan for `<other_type>.<other_local_name>`
  references (Terraform's own interpolation syntax) against every OTHER
  recognized resource collected from the same file. A reference to a
  `postgres`/`mysql`/`mongodb`/… node becomes a `dbConnection` edge; a
  `queue`-mapped node becomes a `queue` edge; anything else becomes a generic
  `serviceCall` edge.
- **No cross-module/`data` source resolution** in this first cut — only
  `resource` blocks in the SAME file are considered; a `module "x" { source =
  "./x" }` reference is not followed into the referenced module's own `.tf`
  files.

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
5. ✅ `kubernetes` extractor — content-detected (no fixed filename); reuses
   `inferTypeFromImage()` and connection-env-var matching from `compose`.
6. ✅ `terraform` extractor — regex over HCL (no HCL parser dependency);
   `medium` confidence, not `high` — see §3.2 for why.

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
