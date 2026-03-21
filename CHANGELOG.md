# Changelog

All notable changes to **`@archrad/deterministic`** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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

### Changed (documentation / messaging)
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
