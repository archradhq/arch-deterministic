# Changelog

All notable changes to **`@archrad/deterministic`** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-04-04

### Fixed

- **CLI** (`validate`, `export`, `validate-drift`): a missing **`--ir`** file now reports **`archrad: --ir file not found: <path>`** instead of **`invalid JSON`**.

### Changed

- **`IR-LINT-MISSING-AUTH-010`** — HTTP entry detection uses **`ParsedLintGraph.inDegree`** (same counts as `buildParsedLintGraph`) instead of a separate scan; reverse adjacency for auth-as-gateway only includes edges whose endpoints exist in **`nodeById`**.
- **Docs:** README documents **OpenAPI security → IR → `IR-LINT-MISSING-AUTH-010`** for the spec-to-compliance workflow.
- **`graphPredicates.ts`:** clarified comments for **`isHttpEndpointType`** vs **`isHttpLikeType`** (`graphql` vs `gateway` / `bff` / `grpc`).

### Added

- **Tests:** structural **`IR-STRUCT-HTTP_*`** coverage for **`graphql`** (validated) vs **`gateway`** (excluded); regression tests locking lint message substrings for **`IR-LINT-DEAD-NODE-011`**, **`IR-LINT-DIRECT-DB-ACCESS-002`**, **`IR-LINT-SYNC-CHAIN-001`** (terminal copy / Show HN).

## [0.1.2] - 2026-03-28

### Fixed

- **`IR-STRUCT-HTTP_PATH` / `IR-STRUCT-HTTP_METHOD` false positives on `gateway`, `grpc`, `bff`** — structural validation previously used `isHttpLikeType` (correct for lint) for the url/method check. A `gateway` node with no `config.url` produced a spurious error; a `grpc` node with `config.method: "GetUser"` produced two. Introduced `isHttpEndpointType` (narrow: `http`, `https`, `rest`, `api`, `graphql`) for the structural check only. `isHttpLikeType` is unchanged for lint.
- **`IR-STRUCT-CYCLE` path lost** — extracted `detectCycles(adj: Map<string, string[]>): string[] | null` from the inline `dfs` closure in `validateIrStructural`. Returns the full ordered cycle path; findings now read `Directed cycle detected: a → b → c → a`. Exported from package root.
- **`IR-STRUCT-NODE_INVALID_CONFIG` (warning)** — `emptyRecord()` previously coerced `"config": ["wrong"]` or `"config": null` silently to `{}`. Structural validation now emits a warning when `config` is present but is not a plain object, including the actual type in the message.

### Added

- **`IR-LINT-MISSING-AUTH-010` (warning)** — fires on HTTP-like entry nodes (no incoming edges, including `gateway`, `bff`, `grpc`) with no auth coverage. A node is covered when: (1) an immediate outgoing neighbour is auth-like (`auth`, `middleware`, `oauth`, `jwt`, `saml`, `keycloak`, `okta`, `cognito`, `auth0`, `ldap`, `iam`, `sso`, etc.), (2) an auth-like node has a direct edge to the entry (auth-as-gateway pattern), or (3) `config` carries any of `auth`, `authRequired`, `authentication`, `authorization`, `security`. Explicit opt-out: `config.authRequired: false` for intentionally public endpoints (health, signup, public assets). Maps directly to PCI-DSS and HIPAA requirements.
- **`IR-LINT-DEAD-NODE-011` (warning)** — fires on nodes with incoming edges but no outgoing edges that are not a recognised sink type (datastore-like, queue-like, or HTTP-like). HTTP nodes are excluded because they return responses to callers. Complements `IR-LINT-ISOLATED-NODE-005` which catches fully disconnected nodes.
- **OpenAPI ingestion — security definitions** — `archrad ingest openapi` now extracts security scheme names into node config following OpenAPI 3.x precedence: global `doc.security` propagates to all operations as `config.security: ["SchemeName"]` (sorted); operation-level `security` overrides global; explicit `security: []` sets `config.authRequired: false`. Nodes with no security at either level produce no security config and are flagged by `IR-LINT-MISSING-AUTH-010` in CI.
- **New predicate exports** — `isHttpEndpointType`, `isAuthLikeNodeType` added to `graphPredicates.ts` and exported from the package root alongside the existing predicates, for consumers building custom lint rules.
- **`detectCycles` exported from package root** — useful for consumers building custom structural validators or tooling on top of the IR adjacency graph.

## [0.1.1] - 2026-03-28

### Added
- **[docs/CUSTOM_RULES.md](docs/CUSTOM_RULES.md)** — custom **`IR-LINT`-style** visitors (`ParsedLintGraph` → **`IrStructuralFinding[]`**): worked **service / `config.timeout`** example, **compose** (`runArchitectureLinting` + org rules) vs **fork** (`LINT_RULE_REGISTRY`); no runtime registry mutation.
- **`archrad validate-drift`** — compare an on-disk export directory to a **fresh** deterministic export from the same IR (`DRIFT-MISSING` / `DRIFT-MODIFIED` / optional `DRIFT-EXTRA` with **`--strict-extra`**); **`--json`** for CI. Library: **`runValidateDrift`**, **`diffExpectedExportAgainstFiles`**, **`runDriftCheckAgainstFiles`**, etc. (`src/validate-drift.ts`).
- **VHS tape** **`scripts/record-demo-drift.tape`** → **`demo-drift.gif`**; **`npm run record:demo:drift`**. Storyboard and recording docs updated (**`scripts/DEMO_GIF_STORYBOARD.md`**). **Replay without VHS:** **`scripts/run-demo-drift-sequence.sh`** / **`.ps1`** for ShareX/OBS/asciinema capture; **`README_DEMO_RECORDING.md`** (**When VHS fails**). **`scripts/invoke-drift-check.ps1`** for repeatable drift checks on Windows.
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
- **`package.json` `keywords`**: **`architecture-as-code`**, **`blueprint`**, **`ir`**, **`validate-drift`** for npm discoverability.

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
- README positioning: **deterministic compiler and linter for system architecture**; validation layers table (OSS vs Cloud); **`validate-drift`**, drift GIF / trust-loop recording docs, library **`runValidateDrift`** example.

[Unreleased]: https://github.com/archradhq/arch-deterministic/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/archradhq/arch-deterministic/releases/tag/v0.1.3
[0.1.2]: https://github.com/archradhq/arch-deterministic/releases/tag/v0.1.2
[0.1.1]: https://github.com/archradhq/arch-deterministic/releases/tag/v0.1.1
[0.1.0]: https://github.com/archradhq/arch-deterministic/releases/tag/v0.1.0
