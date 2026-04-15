# OSS flow diagrams — `@archrad/deterministic`

**Doc revision:** v0.1.6 · package `@archrad/deterministic` 0.1.6 · 2026-04-10 · [OSS doc history & process](./OSS_DOCUMENTATION_VERSIONING.md)

Phase flows for the main **user-visible** paths. Component detail is in [OSS_ARCHITECTURE.md](./OSS_ARCHITECTURE.md).

---

## 1. `archrad validate`

Default path: **structural** (which internally runs `normalizeIrGraph` → `materializeNormalizedGraph` → ref/cycle/HTTP checks) → **lint** only when there are no structural **errors** (`hasIrStructuralErrors`); PolicyPack optional via `--policies`.

```mermaid
flowchart TD
  A[Read IR from --ir] --> B["validateIrStructural\n(normalizeIrGraph + materializeNormalizedGraph + IR-STRUCT-*)"]
  B --> C{hasIrStructuralErrors?}
  C -->|yes| D[Skip validateIrLint]
  C -->|no| E[validateIrLint + optional PolicyPack visitors]
  D --> F[sortFindings / print or --json]
  E --> F
  F --> G{shouldFailFromFindings\npolicy}
  G -->|fail| X[exit 1]
  G -->|pass| Y[exit 0]
```

**Exit policy:** `error` severity always fails; warnings fail only with `--fail-on-warning` or `--max-warnings N`. See `cli-findings.ts`.

---

## 2. `archrad export`

Codegen path: structural → lint (unless skipped) → generate files → optional OpenAPI structural warnings on bundle.

```mermaid
flowchart TD
  A[Read IR] --> B[runDeterministicExport]
  B --> C[validateIrStructural]
  C --> D{Block on structural?}
  D -->|yes| E[Abort / empty files per options]
  D -->|no| F[validateIrLint optional]
  F --> G[pythonFastAPI / nodeExpress]
  G --> H[golden layer Dockerfile compose Makefile]
  H --> I[validateOpenApiInBundleStructural]
  I --> J[Write files to --out]
  J --> K{CLI policy\nfail-on-warning}
  K -->|violates| X[exit 1]
  K -->|ok| Y[exit 0]
```

---

## 3. `archrad validate-drift`

Compare **fresh** deterministic export from IR to **existing** directory tree.

```mermaid
flowchart TD
  A[Read IR + --export-dir] --> B[runValidateDrift]
  B --> C[Normalize / structural + lint for export build]
  C --> D[runDeterministicExport in memory]
  D --> E[Read on-disk files]
  E --> F[diff expected vs actual]
  F --> G[DRIFT-MISSING / DRIFT-MODIFIED / ...]
  G --> H[Exit code from combined findings + policy]
```

---

## 4. MCP session (stdio)

Tools delegate to the same functions as the CLI; no separate “cloud” engine.

```mermaid
sequenceDiagram
  participant IDE as IDE / host
  participant MCP as archrad-mcp
  participant L as Library core

  IDE->>MCP: stdio JSON-RPC
  MCP->>L: archrad_validate_ir (load IR)
  L->>L: normalize → structural → lint
  L-->>MCP: findings JSON
  MCP-->>IDE: tool result

  IDE->>MCP: archrad_validate_drift
  MCP->>L: runValidateDrift
  L-->>MCP: drift + IR findings
  MCP-->>IDE: tool result
```

---

## 5. OpenAPI ingest (high level)

Separate command path: spec → canonical IR graph (not shown in full here); output feeds **`archrad validate`** like any other IR file.

```mermaid
flowchart LR
  OAS[OpenAPI file] --> ING[ingest openapi]
  ING --> IR[graph.json IR]
  IR --> VAL[archrad validate]
```

---

## See also

- [OSS_DESIGN.md](./OSS_DESIGN.md)
- [OSS_ARCHITECTURE.md](./OSS_ARCHITECTURE.md)
- [CI.md](./CI.md) — pipeline snippets
