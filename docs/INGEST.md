# Ingest — enterprise artifacts → ArchRad IR

**Status:** 0.2.x — `archrad ingest backstage`, `archrad ingest openapi`, `archrad fragment merge`.

This document describes how to turn **Backstage YAML catalogs** and **OpenAPI** documents into **canonical IR** JSON, optionally **merge** fragments, then **`archrad validate`** (and export) as usual.

## 1. Commands

| Command | Purpose |
|--------|---------|
| `archrad ingest backstage` | Scan a directory for Backstage `catalog-info.yaml` / `catalog.yaml`, map entities → IR |
| `archrad ingest openapi` | OpenAPI 3.x → IR (HTTP nodes per operation) |
| `archrad fragment merge` | Combine 2+ IR JSON files into one graph |

### 1.1 `archrad ingest backstage`

**Scope (OSS):** **YAML on disk only** — recursive scan under `--catalog`. A live **Backstage Catalog API** (`/api/catalog/entities`) client is **not** included; defer that to a future release or product pipeline.

- **Scans** recursively under `--catalog <dir>`.
- **Skips** directories: `node_modules`, `dist`, `.git`, `build`, `coverage`, `.next`, `target`.
- **Kinds mapped:** `Component`, `Resource`, `API`, `System`.
- **Location:** `kind: Location` with `spec.targets` or `spec.target` pointing at **local files** adds those files to the scan. **http(s)** URL targets are **not** fetched; they appear in the ingest report under `skipped`.
- **Edges:** `Component.spec.dependsOn` (entity refs) and `Component.spec.system` (system ref) become edges when the target entity exists in the same ingest run.

```bash
archrad ingest backstage --catalog ./services --out backstage.json
archrad ingest backstage --catalog ./services --out backstage.json --report-json  # stderr: JSON report
```

### 1.2 `archrad ingest openapi`

- **`--spec`** may be a **local path** (JSON or YAML) or **http(s) URL** (fetches the document).
- **`-H` / `--header`** — repeatable. **Only used when `--spec` is a URL.** Format: `-H "Header-Name: value"` (e.g. `Authorization: Bearer …`). Merged with default `Accept` and `User-Agent`.

```bash
archrad ingest openapi --spec ./openapi.yaml --out openapi.json
archrad ingest openapi --spec https://api.company.com/openapi.json --out openapi.json
archrad ingest openapi --spec https://api.internal/v1/openapi.yaml -H "Authorization: Bearer $TOKEN" -o openapi.json
```

### 1.3 `archrad fragment merge`

**Default:** **union by global `node.id`** across fragments:

- Same **`id`** and **identical** node body (type, kind, name, config, …) → **one** node (deduped).
- Same **`id`** but **different** definition → **exit 1**, **conflict lines on stderr** (no output file).
- **Edges** from all fragments are merged; duplicate edges (same endpoints + metadata) are deduped. Edges pointing at a missing node id emit a **WARN** line on stderr and are skipped.

**`--prefix-fragments`:** legacy **disjoint union** — each fragment’s node and edge ids are prefixed with that fragment’s label (basename by default), so no cross-fragment id matching.

```bash
archrad fragment merge --fragments backstage.json openapi.json --out combined.json
archrad fragment merge -f a.json b.json -o combined.json --prefix-fragments
```

## 2. Demo workflow

```bash
archrad ingest backstage --catalog ./services --out backstage.json
archrad ingest openapi --spec https://api.company.com/openapi.json --out openapi.json
archrad fragment merge --fragments backstage.json openapi.json --out combined.json
archrad validate --ir combined.json
```

## 3. Implementation map

| Area | Source |
|------|--------|
| OpenAPI URL + file read + optional headers | `src/ingest/openapi.ts` |
| OpenAPI → IR | `src/openapi-to-ir.ts` |
| Backstage → IR | `src/ingest/backstage.ts` |
| Fragment merge | `src/fragment/merge.ts` |
| CLI wiring | `src/cli.ts` |

## 4. Limitations (OSS)

- **Backstage:** YAML files only; no live catalog API in this package. URL `Location` targets are not resolved.
- **Merge (default):** Union-by-id is not a full semantic join across teams — use **`--prefix-fragments`** when fragments reuse ids for different things.
- **IR schema:** Ingest emits the same **IR graph v1** shape as the rest of `@archrad/deterministic` (see **`schemas/`** and **`docs/IR_CONTRACT.md`**). There is no separate “IR v1.1” schema in OSS.
- **Validation:** Merged IR may still surface **IR-LINT-*** warnings; structural validation is unchanged.

## 5. See also

- **`docs/IR_CONTRACT.md`** — IR shape
- **`README.md`** — CLI overview
