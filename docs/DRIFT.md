# Deterministic drift (`validate-drift`)

**Canonical OSS description** — versioned with **`@archrad/deterministic`**.  
**Not** semantic “does this code match business intent?” — that class of analysis is out of scope for this layer (see **`STRUCTURAL_VS_SEMANTIC_VALIDATION.md`**).

## What it is

**Drift** here means: you already have an **on-disk tree** (usually from `archrad export`), and you want to know whether it still matches what the **deterministic exporter would produce today** from the **same IR**.

The engine:

1. Runs a **fresh export** from your IR in memory (same pipeline as `archrad export`).
2. Compares the **expected file set + contents** to what is on disk (paths normalized, line endings normalized to `\n`).
3. Emits **DRIFT-*** findings when something is missing, changed, or (optionally) extra.

So: **regen vs reality** — a thin gate for CI and pre-merge checks.

## What it is not

- **Not** diffing IR to arbitrary hand-written code semantics.
- **Not** proving runtime behavior or security — use tests, review, and (where applicable) **ArchRad Cloud** governance.

## CLI

```bash
archrad validate-drift -i ./graph.json -t python -o ./out
```

Use **`--json`** in CI. **`--strict-extra`** treats unexpected files in the output directory as findings. **`--skip-ir-lint`** / **`--policies`** follow the same semantics as **`export`** (see **`README.md`**).

## Library

**`runValidateDrift`**, **`diffExpectedExportAgainstFiles`**, **`readDirectoryAsExportMap`** — see **`src/validate-drift.ts`**.

## MCP

**`archrad_validate_drift`** — same semantics: IR (inline or **`irPath`**) + **`target`** + **`exportDir`**. See **`MCP.md`**.

## DRIFT-* codes

| Code | Meaning |
|------|--------|
| **DRIFT-MISSING** | A file the exporter would emit is missing on disk. |
| **DRIFT-MODIFIED** | File exists but content differs from the deterministic export. |
| **DRIFT-EXTRA** | File exists on disk but is not in the reference export (with **`--strict-extra`**). |
| **DRIFT-NO-EXPORT** | Exporter produced no file map (often blocked by structural/lint errors or empty target output). |

Remediation text for each code (aligned with MCP **`archrad_suggest_fix`**) lives in **`RULE_CODES.md`** and **`src/static-rule-guidance.ts`**.

## Product site

**archrad.com** may host narrative pages (e.g. `/docs/drift`) for onboarding; **definitions and CLI/MCP behavior** are maintained **here** in the OSS repo so they ship with the engine.
