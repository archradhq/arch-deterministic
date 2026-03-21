# Structural vs semantic validation (open core)

This document defines how **@archrad/deterministic** (OSS) and **ArchRad Cloud** (product) split validation.

**OSS positioning:** *Includes structural validation + basic architecture linting (rule-based, deterministic).*

## OSS layers (names)

| Name in docs | Role |
|--------------|------|
| **IR structural validation** | Graph shape, references, cycles, HTTP path/method |
| **Architecture lint (basic)** | Deterministic heuristics (`IR-LINT-*`), no AI |
| **OpenAPI structural validation** | Document **shape** on generated spec (parse + required fields) |

## Structural (OSS)

**Question:** Is the blueprint IR **well-formed** and **safe for the deterministic compiler**?

**Where:** `validateIrStructural()`, first step of `archrad validate` / `archrad export`.

**Examples:**

| Code | Meaning |
|------|---------|
| `IR-STRUCT-EDGE_UNKNOWN_FROM` | Edge references a node id that does not exist |
| `IR-STRUCT-CYCLE` | Directed cycle in the dependency graph |
| `IR-STRUCT-HTTP_PATH` | HTTP node `config.url` must start with `/` |
| `IR-STRUCT-DUP_NODE_ID` | Two nodes share the same `id` |

Findings use **`severity`**: `error` (blocks export) or `warning` / `info` when applicable.

**Contract:** See **`schemas/archrad-ir-graph-v1.schema.json`** for JSON shape; code rules may be stricter. **Parser boundary and normalized node/edge shapes:** [IR_CONTRACT.md](./IR_CONTRACT.md).

## Architecture lint (OSS)

**Question:** Does the graph trip **light, rule-based** architecture smells (still deterministic)?

**Where:** `validateIrLint()`, `archrad validate` (after structural pass), `archrad export` (unless `--skip-ir-lint`).

| Code | Meaning |
|------|---------|
| `IR-LINT-DIRECT-DB-ACCESS-002` | HTTP node has a direct edge to a datastore-like node |
| `IR-LINT-SYNC-CHAIN-001` | Long synchronous dependency chain from an HTTP entry |
| `IR-LINT-NO-HEALTHCHECK-003` | HTTP routes exist but no typical `/health` / `/live` / `/ready` path |
| `IR-LINT-HIGH-FANOUT-004` | Node with ≥5 outgoing edges |

**CI:** `archrad validate --fail-on-warning` or `--max-warnings N`. Not org-specific policy — that stays in Cloud.

## Semantic (ArchRad Cloud)

**Question:** Is this architecture **appropriate** for security, compliance, scale, and org policy?

**Marketing / product names:** **Policy engine**, **architecture intelligence**, **AI remediation** (not shipped in `@archrad/deterministic`).

**Examples:** missing auth on sensitive routes, PII handling, SOC2 mapping, deeper bottleneck analysis, idempotency guidance, **AI-assisted repair loops**.

This layer is **not** required to use the OSS CLI or library offline.

## OpenAPI “document shape” (OSS, post-generation)

After codegen, **`validateOpenApiInBundleStructural`** checks that the generated spec is **parseable OpenAPI 3.x** with **`paths`**, **`info.title`**, and **`info.version`**.

That is **document shape**, not full API linting: it does **not** enforce Spectral-style rules (e.g. mandatory `security`, `operationId` conventions, or style). Use Spectral or Cloud semantic checks if you need that depth.

## Codegen vs validation (retry / timeouts)

The FastAPI/Express generators **can emit** retry, backoff, or circuit-breaker **code** when the IR includes the right edge/node config. That is **generation**, not proof that every external call is resilient.

Requiring “timeouts and retries on all third-party calls” is a **policy / semantic** concern — a good fit for **ArchRad Cloud** or org-specific tooling, not the baseline OSS structural layer.

## OSS package vs InkByte product

**`@archrad/deterministic`** (and the public **`arch-deterministic`** repo) ship only what is in this package: IR structural rules, deterministic export, OpenAPI document-shape check, golden Docker/Makefile.

The **InkByte** monorepo may contain additional validation, analyzers, and LLM workflows under **`server/`** and elsewhere. Those are **not** implied by the OSS README unless the same code is published in this package.

## One-line summary

- **Structural:** “Your graph **compiles**.”
- **Semantic:** “Your graph **should** run in production, per policy and best practice.”
