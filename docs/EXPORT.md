# Deterministic export (`archrad export`)

**Canonical OSS description** — ships with **`@archrad/deterministic`**.

## What it is

**`archrad export`** runs the same **deterministic pipeline** as the library’s **`runDeterministicExport`**:

1. **Validate** IR structurally (**`IR-STRUCT-*`**) and optionally architecture lint (**`IR-LINT-*`**) and optional **PolicyPack** rules.
2. **Generate** target-specific code: **FastAPI** (`python`) or **Express** (`node` / `nodejs`).
3. **Emit** OpenAPI (document-shape), app entrypoints, and a **golden bundle** (Dockerfile, `docker-compose.yml`, Makefile, README) with a configurable **host** port for local publish.

Output is **fully deterministic** for a given IR + target + options — no LLM, no network calls.

## Public roadmap

**Export is intentionally part of the OSS package.** It is not a “secret” or internal-only product feature: the **deterministic compiler** (validate → codegen → golden bundle) is the trust hook described on **`README.md`** and in **`OSS_VS_PRODUCT_REPOS.md`** (monorepo: **`packages/deterministic`**).

What stays **product / Cloud** (not in this repo) is hosted UX, org policy beyond PolicyPack, semantic analysis, AI remediation, and managed pipelines. **Scaffolding from IR** in this package is the **public** baseline so CI and local runs match.

If a **marketing roadmap** page (e.g. archrad.com) lists only “validate” and “ingest,” that is a **positioning** choice, not a license restriction — **`export`** remains the canonical OSS path for **IR → files**.

## CLI

Full flags: **`CLI_REFERENCE.md`** → **`archrad export`**.

```bash
archrad export --ir ./graph.json --target python --out ./my-api
```

## Related

- **`validate-drift`** — compare a previous export on disk to a fresh export; **`DRIFT.md`**.
- **OpenAPI document-shape** — not Spectral-style lint; **`STRUCTURAL_VS_SEMANTIC_VALIDATION.md`**.
- **Engineering** — **`ENGINEERING_NOTES.md`**, **`src/exportPipeline.ts`**.
