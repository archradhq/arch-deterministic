# Changelog

All notable changes to **`@archrad/deterministic`** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`graphPredicates.ts`**: shared **`isHttpLikeType`** / **`isDbLikeType`** / **`isQueueLikeNodeType`** (exported from the package root) so structural HTTP checks and IR-LINT stay aligned.
- **`IR-STRUCT-EDGE_AMBIGUOUS_FROM` / `IR-STRUCT-EDGE_AMBIGUOUS_TO`** when an edge references a **duplicate** node id.
- **`ParsedLintGraph.inDegree`**, **`BuildParsedLintGraphResult`**, **`isParsedLintGraph()`** — `buildParsedLintGraph` returns **`{ findings }`** on parse failure instead of **`null`**.
- Richer **`IR-STRUCT-CYCLE`** message (example node on the cycle) and **`nodeId`** when detectable.
- **`archrad yaml-to-ir`** — YAML blueprint → canonical `{ "graph": … }` JSON (`-y/--yaml`, `-o/--out` or stdout). Library: **`parseYamlToCanonicalIr`**, **`canonicalIrToJsonString`**, **`YamlGraphParseError`**. Fixture **`fixtures/minimal-graph.yaml`**.
- **Five architecture lint rules** (`IR-LINT-ISOLATED-NODE-005` … **009**): isolated nodes when the graph has edges elsewhere, duplicate edges, HTTP missing `name`, datastore with no incoming edges, multiple HTTP entry nodes. CLI prints **Architecture lint (IR-LINT-*)** in a separate block from structural findings.
- Launch line: **Validate your architecture before you write code.** (README, `llms.txt`, npm `description`, `archrad --help` / `validate` description, clean `archrad validate` stdout).
- **`ir-normalize`** (`materializeNormalizedGraph`, `NormalizedGraph` / node / edge types) — parser boundary docs in **`docs/IR_CONTRACT.md`**; README **Validation levels** (JSON Schema → IR structural → export-time OpenAPI structural).
- **`llms.txt`** at package root — markdown summary for LLM/agent discovery (included in npm tarball).
- **IR structural validation** (`validateIrStructural`, `normalizeIrGraph`, `hasIrStructuralErrors`): node ids, HTTP path/method, edge endpoints, directed **cycles**; codes like `IR-STRUCT-*`.
- **Architecture lint** (`validateIrLint`, **`IR-LINT-*`**): deterministic rules only — direct **HTTP→DB** edge, **sync chain** depth from HTTP entry, **missing health** path, **high fan-out** (≥5 outbound edges). No AI, no org policy.
- **`archrad validate --ir <path>`** — structural + lint; **`--json`**; pretty output; **`--skip-lint`**, **`--fail-on-warning`**, **`--max-warnings <n>`** for CI.
- **`schemas/archrad-ir-graph-v1.schema.json`** — documented JSON shape for the graph IR (companion to code rules).
- **`runDeterministicExport`** returns **`irStructuralFindings`** and **`irLintFindings`**; **structural errors** block codegen unless **`skipIrStructuralValidation`**.
- CLI **`export`**: **`--skip-ir-structural-validation`**, **`--skip-ir-lint`**, **`--fail-on-warning`**, **`--max-warnings <n>`** (blocks writes when IR policy fails).
- Library: **`validateIrLint`**, **`sortFindings`**, **`shouldFailFromFindings`**, **`IrFindingLayer`**.
- Fixtures **`invalid-edge-unknown-node.json`**, **`invalid-cycle.json`** for negative tests; **`ecommerce-with-warnings.json`** triggers all four **`IR-LINT-*`** rules for demos and tests.

### Changed
- **`validateIrLint`** returns **structural findings** when the IR cannot be built (same codes as **`normalizeIrGraph`** / empty graph), instead of **`[]`**.
- **`runDeterministicExport`**: when **`skipIrStructuralValidation`** is set, **`IR-STRUCT-*`** from **`validateIrLint`** are merged into **`irStructuralFindings`** (and block codegen on errors); **`irLintFindings`** stays **`IR-LINT-*`** only — aligns server logging and product “fail closed” on invalid/empty IR.
- **`normalizeEdgeSlot`**: top-level **`edge.kind`** is copied into **`metadata.kind`** when metadata does not already set **`kind`** (preserves async lint signal).
- **`edgeRepresentsAsyncBoundary`**: considers top-level **`kind`**, optional **`ParsedLintGraph`** (queue-like **target** nodes), and normalized metadata.
- **`IR-LINT-DIRECT-DB-ACCESS-002`**: one finding per **`(from,to)`** pair (deduped parallel edges).
- **`looksLikeHealthUrl`**: **`/healthcheck`**, **`/ping`**, **`/status`**, **`/alive`** (and **`ruleNoHealthcheck`** message notes gateway/BFF heuristic).
- **`isHttpLikeType`**: **`gateway`**, **`bff`**, **`graphql`**, **`grpc`**, and word-boundary matches for common API surface types.

### Changed (engineering / safety)
- **TypeScript `strict: true`** + **`noUnusedLocals` / `noUnusedParameters`**; **`npm test`** runs **`tsc --noEmit`** before Vitest.
- **`prepare`** removed; **`prepublishOnly`** runs **`npm run build`** for npm publishes. Monorepo consumers must build this package explicitly (unchanged for InkByte CI).
- **Biome** added with a **minimal** lint ruleset (`npm run lint`); expand rules incrementally — see **`docs/ENGINEERING_NOTES.md`**.
- **IR-LINT-SYNC-CHAIN-001** uses **sync-only** adjacency; edges marked async (`metadata.protocol`, `config.async`, etc.) are excluded — see **`edgeRepresentsAsyncBoundary`** in `lint-graph.ts`.
- **CLI:** **`--danger-skip-ir-structural-validation`** documented; **`--skip-ir-structural-validation`** hidden (deprecated alias).

### Changed (documentation / messaging)
- **`docs/CONCEPT_ADOPTION_AND_LIMITS.md`** — honest framing: strengths (IR as SoT, compiler model, tiered validation), adoption friction (IR authoring, one-way export), OSS-as-trust vs platform adoption; README + `llms.txt` summaries and links.
- Canonical **OSS positioning** line in README, `llms.txt`, monorepo/OSS docs: *Includes structural validation + basic architecture linting (rule-based, deterministic).*
- Clarified OpenAPI pass as **document shape** (parse + required top-level fields), explicitly **not** Spectral-style lint; README + `docs/STRUCTURAL_VS_SEMANTIC_VALIDATION.md` + code comments.
- Documented **codegen vs validation** for retry/timeout IR fields and **InkByte vs OSS** scope in README and structural/semantic doc.
- README positioning: **deterministic compiler and linter for system architecture**; validation layers table (OSS vs Cloud).

## [0.1.0] - 2026-02-26

### Added
- Deterministic **FastAPI** and **Express** generators from blueprint **IR** (JSON graph).
- **`archrad export`** CLI (`--ir`, `--target`, `--out`).
- **Structural OpenAPI** validation pass on generated bundles (warnings, no LLM repair).
- **Golden path**: `docker-compose.yml`, `Dockerfile`, `Makefile`, README section; container port **8080**; configurable **host** publish port (`--host-port` / `ARCHRAD_HOST_PORT`).
- Optional **localhost preflight** for host port (warn or `--strict-host-port`).
- Library API: `runDeterministicExport`, OpenAPI helpers, golden-layer helpers.

[Unreleased]: https://github.com/archradhq/arch-deterministic/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/archradhq/arch-deterministic/releases/tag/v0.1.0
