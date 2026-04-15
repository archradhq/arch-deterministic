# OSS design — `@archrad/deterministic`

**Doc revision:** v0.1.6 · package `@archrad/deterministic` 0.1.6 · 2026-04-10 · [OSS doc history & process](./OSS_DOCUMENTATION_VERSIONING.md)

This document is the **design record** for the public, Apache-2.0 **ArchRad deterministic** package (`archrad` CLI, `archrad-mcp`, library API). It complements the **contract** docs (`IR_CONTRACT.md`, `schemas/`) and the **boundary** doc (`STRUCTURAL_VS_SEMANTIC_VALIDATION.md`).

---

## 1. Purpose

**Problem:** Teams need to treat **architecture as code** — a machine-checkable blueprint — and catch structural mistakes and common integration smells **before** implementation drifts from intent.

**Solution:** A **deterministic** pipeline (no LLM in the default path) that:

1. Accepts an **intermediate representation (IR)** graph (JSON; optional YAML/OpenAPI ingestion to produce IR).
2. **Validates** structure (`IR-STRUCT-*`) and runs **architecture lint** (`IR-LINT-*`) plus optional **PolicyPack** rules.
3. Optionally **exports** FastAPI or Node/Express **reference** code, OpenAPI bundle, and **golden** Docker/Makefile glue.
4. Optionally **compares** that export to files on disk (**drift** / `DRIFT-*`).

**Non-goals (OSS):** hosted identity, org billing, semantic/compliance reasoning beyond deterministic rules, AI remediation, managed policy beyond PolicyPack YAML/JSON. Those are **product** concerns — see `STRUCTURAL_VS_SEMANTIC_VALIDATION.md`.

---

## 2. Design principles

| Principle | Implication |
|-----------|-------------|
| **Determinism** | Same IR + same version + same flags → same findings and same generated files (modulo explicit timestamps if any). |
| **No silent pass** | Invalid or empty IR yields structural findings; lint is skipped when structural errors block a safe parse where documented. |
| **Layered validation** | Structural first, then lint on a **parsed** graph; export repeats validation unless explicitly skipped (dangerous for codegen). |
| **Explicit rule codes** | `IR-STRUCT-*`, `IR-LINT-*`, `DRIFT-*` for automation and docs (`RULE_CODES.md`, MCP `docsUrl`). |
| **Small, testable core** | Visitors in `lint-rules.ts`; graph in `lint-graph.ts`; policy compiler in `policy-pack.ts`. |
| **OSS packaging** | `dist/` published; training `corpus/` may stay git-only (`.npmignore`); fixtures ship for tests and demos. |

---

## 3. Scope boundary (OSS vs product)

| OSS (`@archrad/deterministic`) | Product (ArchRad Cloud / InkByte) |
|--------------------------------|-------------------------------------|
| IR structural + `IR-LINT-*` + PolicyPack **files** | Org policy packs in hosted settings, semantic analysis |
| `archrad validate`, `export`, `validate-drift`, `ingest openapi` | Full builder UI, accounts, billing |
| `archrad-mcp` over stdio, static `suggest_fix` text | Cloud LLM, managed remediation loops |
| OpenAPI **document-shape** on **generated** spec | Full API design governance beyond shape |

---

## 4. Intermediate representation (IR)

- **Shape:** JSON with a `graph` object: `nodes[]`, `edges[]`, optional `metadata`. Node `type` drives codegen and lint predicates (`graphPredicates.ts`).
- **Normalization:** `normalizeIrGraph` (`ir-structural.ts`) extracts the graph object; `materializeNormalizedGraph` (`ir-normalize.ts`) assigns stable ids and edge slots; failures become `IR-STRUCT-*` or normalize-phase findings.
- **Schema:** `schemas/archrad-ir-graph-v1.schema.json` (document shape); **code** may enforce additional rules.

---

## 5. Major subsystems

### 5.1 Structural validation (`ir-structural.ts`)

- Validates referential integrity, cycles, HTTP path/method for endpoint-like types, duplicate ids, etc.
- **Severity:** typically `error` for blockers.

### 5.2 Lint graph & rules (`lint-graph.ts`, `lint-rules.ts`)

- **`buildParsedLintGraph`:** IR → adjacency, degrees, typed nodes for visitors.
- **`LINT_RULE_REGISTRY`:** ordered list of pure functions `(ParsedLintGraph) → IrStructuralFinding[]` with `layer: 'lint'`.
- **Async edges:** `edgeRepresentsAsyncBoundary` excludes edges from sync-chain depth where marked queue/async.

### 5.3 Policy packs (`policy-pack.ts`)

- Load YAML/JSON **PolicyPack** documents; compile to **visitors** merged **after** built-in `IR-LINT-*` (unless lint skipped).

### 5.4 Export pipeline (`exportPipeline.ts`, `pythonFastAPI.ts`, `nodeExpress.ts`)

- Target `python` | `nodejs` (CLI may alias `node`).
- Emits file map; merges structural + lint findings; optional OpenAPI structural pass on bundle.

### 5.5 Drift (`validate-drift.ts`)

- Re-runs deterministic export in memory, normalizes file content, diffs to on-disk tree → `DRIFT-*`.

### 5.6 CLI (`cli.ts`)

- Commands: `validate`, `export`, `validate-drift`, `yaml-to-ir`, `ingest openapi`, etc.
- Exit policy: `shouldFailFromFindings` — errors always fail; warnings optionally via `--fail-on-warning` / `--max-warnings`.

### 5.7 MCP (`mcp-server.ts`)

- stdio MCP server; tools wrap the **same** validation/drift/policy loaders as the CLI (no separate business logic).

---

## 6. Public API surface

- **Package root:** `validateIrStructural`, `validateIrLint`, `runDeterministicExport`, `runValidateDrift`, `loadPolicyPacksFromDirectory`, `sortFindings`, `shouldFailFromFindings`, OpenAPI helpers, etc. — see `src/index.ts` / published `dist/index.d.ts`.
- **Bins:** `archrad`, `archrad-mcp`.

---

## 7. Observability & CI

- Human-readable stderr for findings; `--json` where implemented.
- **`docs/CI.md`** — exit codes and sample pipelines.

---

## 8. Repository & release model

- **Monorepo** (InkByte): `packages/deterministic` is source of truth for implementation.
- **Public mirror:** `archradhq/arch-deterministic` via `git subtree split` (see `RELEASING.md`).
- **npm:** `@archrad/deterministic`; version aligned with git tags on the OSS repo.

---

## 9. Related diagrams

- **Component relationships:** [OSS_ARCHITECTURE.md](./OSS_ARCHITECTURE.md)
- **Request/phase flows:** [OSS_FLOWS.md](./OSS_FLOWS.md)

---

## 10. References

- `STRUCTURAL_VS_SEMANTIC_VALIDATION.md` — OSS vs Cloud
- `IR_CONTRACT.md` — parser boundary
- `CUSTOM_RULES.md` — custom visitors
- `DRIFT.md` — drift semantics
- `MCP.md` — MCP tools
