# `archrad` CLI — reference

Canonical **flags** for **`@archrad/deterministic`**. Behavior is implemented in **`src/cli.ts`**; deeper semantics live in linked docs.

| Topic | Doc |
|-------|-----|
| IR shape | **`IR_CONTRACT.md`** |
| Ingest + merge | **`INGEST.md`** |
| Drift codes | **`DRIFT.md`**, **`RULE_CODES.md`** |
| Deterministic export / codegen | **`EXPORT.md`** |
| Policy packs | **`CUSTOM_RULES.md`**, **`src/policy-pack.ts`** |

---

## `archrad validate`

Structural validation (**`IR-STRUCT-*`**) plus architecture lint (**`IR-LINT-*`**), unless skipped.

| Option | Description |
|--------|-------------|
| **`-i, --ir <path>`** | IR JSON file (required). |
| **`--json`** | Print findings as a JSON array on **stdout** (CI / automation). |
| **`--skip-lint`** | Skip **`IR-LINT-*`**; only structural findings. |
| **`--policies <dir>`** | PolicyPack YAML/JSON directory; merged after built-in **`IR-LINT-*`** (unless **`--skip-lint`**). |
| **`--fail-on-warning`** | Exit **1** if any warning (or structural error). |
| **`--max-warnings <n>`** | Exit **1** if warning count **>** `n`. |

```bash
archrad validate --ir ./graph.json
archrad validate --ir ./graph.json --json
archrad validate --ir ./graph.json --skip-lint
```

---

## `archrad export`

Generate a **FastAPI** or **Express** project bundle (app code, OpenAPI, golden Docker/Makefile) from IR. Same pipeline as **`runDeterministicExport`** in the library.

| Option | Description |
|--------|-------------|
| **`-i, --ir <path>`** | IR JSON (required). |
| **`-t, --target <name>`** | **`python`** \| **`node`** \| **`nodejs`**. |
| **`-o, --out <dir>`** | Output directory (required). |
| **`-p, --host-port <port>`** | Host port for compose publish (container stays **8080**). Env: **`ARCHRAD_HOST_PORT`**. |
| **`--skip-host-port-check`** | Do not probe **127.0.0.1** for a free port. |
| **`--strict-host-port`** | Exit **1** if host port appears in use. |
| **`--skip-ir-lint`** | Skip **`IR-LINT-*`** during export (structural still runs unless skipped below). |
| **`--policies <dir>`** | PolicyPack directory for lint when **`--skip-ir-lint`** is not set. |
| **`--fail-on-warning`** | Do **not** write files if warnings exceed policy. |
| **`--max-warnings <n>`** | Fail export if total warning count **>** `n`. |
| **`--danger-skip-ir-structural-validation`** | Unsafe: skip **`IR-STRUCT-*`** (not for CI). |

See **`EXPORT.md`** for pipeline details and public positioning.

---

## `archrad validate-drift`

Compare an **on-disk** previous export directory to a **fresh** deterministic export from the same IR. See **`DRIFT.md`**.

| Option | Description |
|--------|-------------|
| **`-i, --ir <path>`** | IR JSON (required). |
| **`-t, --target <name>`** | **`python`** \| **`node`** \| **`nodejs`** (must match how the tree was produced). |
| **`-o, --out <dir>`** | Directory containing the export to compare (required). |
| **`-p, --host-port <port>`** | Must match the export’s golden host port. |
| **`--skip-host-port-check`** | Same as export. |
| **`--skip-ir-lint`** | Skip lint when building the **reference** export. |
| **`--policies <dir>`** | Policy packs for reference export (same as export). |
| **`--strict-extra`** | Fail if **extra** files exist on disk that are not in the reference export. |
| **`--json`** | Print drift + export metadata as JSON on **stdout**. |
| **`--danger-skip-ir-structural-validation`** | Unsafe: skip structural validation for reference export. |

---

## `archrad yaml-to-ir`

Convert a **YAML** blueprint to canonical **`{ graph: … }`** JSON (same shape as hand-authored IR JSON).

| Option | Description |
|--------|-------------|
| **`-y, --yaml <path-or-url>`** | Local path **or** **https** URL (e.g. GitHub **raw** blueprint). |
| **`-o, --out <path>`** | Write JSON; default: print to **stdout**. |
| **`-H, --header <pair>`** | Repeatable; **only when `--yaml` is a URL** (e.g. private repo token). |

```bash
archrad yaml-to-ir --yaml ./blueprint.yaml -o ./graph.json
archrad yaml-to-ir --yaml https://raw.githubusercontent.com/org/repo/main/docs/graph.yaml -o ./graph.json
archrad validate --ir ./graph.json
```

One-liner (fetch + validate to a temp file):

```bash
archrad yaml-to-ir -y "https://raw.githubusercontent.com/.../minimal-graph.yaml" -o /tmp/g.json && archrad validate --ir /tmp/g.json
```

**Discover files on GitHub (public repo):** the [GitHub Code Search API](https://docs.github.com/en/rest/search/search#search-code) requires authentication. For unauthenticated use, the [Git Tree API](https://docs.github.com/en/rest/git/trees#get-a-tree) lists paths under a branch. Script **`scripts/github-validate-samples.mjs`** accepts **`--repo owner/name`**, **`--ref`**, **`--prefix path/`**, and **`--max N`**: it walks YAML paths, classifies **OpenAPI** vs ArchRad **blueprint** (`graph:` / `nodes:`), skips typical Kubernetes manifests, then runs **`yaml-to-ir`** or **`ingest openapi`** + **`validate`**.

```bash
node scripts/github-validate-samples.mjs --repo OAI/OpenAPI-Specification --prefix _archive_/schemas/v3.0/pass/ --max 3
node scripts/github-validate-samples.mjs --repo archradhq/arch-deterministic --prefix fixtures/ --max 4
```

---

## `archrad init`

Generate IR from **Docker Compose** (cold start). See **`INGEST.md`** § init.

| Option | Description |
|--------|-------------|
| **`-f, --from <path>`** | Compose file (**`docker-compose.yml`**, **`compose.yaml`**, **`compose.yml`**) (required). |
| **`-o, --output <path>`** | Write IR JSON; default **`archrad-graph.json`**. |
| **`--dry-run`** | Print IR JSON to **stdout**; do not write a file. |
| **`--verbose`** | Mapping lines to **stderr**. |

---

## `archrad ingest openapi`

| Option | Description |
|--------|-------------|
| **`-s, --spec <path-or-url>`** | Local path or **https** URL (required). |
| **`-o, --out <path>`** | Write IR JSON; default: **stdout**. |
| **`-H, --header <pair>`** | Repeatable; **only when `--spec` is a URL**. |

---

## `archrad ingest backstage`

| Option | Description |
|--------|-------------|
| **`-c, --catalog <dir>`** | Root to scan for **`catalog-info.yaml`** / **`catalog.yaml`** (required). |
| **`-o, --out <path>`** | Write IR JSON; default: **stdout**. |
| **`--report-json`** | Print ingest report (JSON) to **stderr** (instead of human summary). |

---

## `archrad fragment merge`

| Option | Description |
|--------|-------------|
| **`-f, --fragments <files...>`** | Two or more IR JSON paths (required). |
| **`-o, --out <path>`** | Merged IR; default: **stdout**. |
| **`--prefix-fragments`** | Disjoint union (prefixed ids); **`provenance.mode: 'prefix'`**. |

---

## Version

`archrad --version` matches **`package.json`** for **`@archrad/deterministic`**.
