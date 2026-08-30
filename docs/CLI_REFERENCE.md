# `archrad` CLI — reference

Canonical **flags** for **`@archrad/deterministic`**. Behavior is implemented in **`src/cli.ts`**; deeper semantics live in linked docs.

| Topic | Doc |
|-------|-----|
| IR shape | **`IR_CONTRACT.md`** |
| Ingest + merge | **`INGEST.md`** |
| Drift codes | **`DRIFT.md`**, **`RULE_CODES.md`** |
| Implementation drift | **`RULE_CODES.md`** (IR-DRIFT-IMPL-*), README § Implementation governance |
| Deterministic export / codegen | **`EXPORT.md`** |
| Policy packs | **`CUSTOM_RULES.md`**, **`src/policy-pack.ts`** |
| Project config (**`archrad.yml`**) | **`CONFIG.md`** |

---

## Project config (`archrad.yml`)

`archrad` walks up from the CWD looking for **`archrad.yml`** (or **`archrad.yaml`**) and, when found, uses its values as **defaults** for matching flags on `validate`, `lint`, `export`, `validate-drift`, `reconstruct`, and `init`. Explicit CLI flags always win. See **`CONFIG.md`** for the full schema.

| Global option | Description |
|---------------|-------------|
| **`--config <path>`** | Explicit path to a config file (bypasses upward discovery). |
| **`--no-config`** | Ignore any discovered config. |

---

## `archrad validate`

Structural validation (**`IR-STRUCT-*`**) plus architecture lint (**`IR-LINT-*`**), unless skipped.

| Option | Description |
|--------|-------------|
| **`-i, --ir <path>`** | IR JSON file (required). |
| **`--json`** | Print findings as a JSON array on **stdout** (CI / automation). |
| **`--skip-lint`** | Skip **`IR-LINT-*`**; only structural findings. |
| **`--policies <dir>`** | PolicyPack YAML/JSON directory; merged after built-in **`IR-LINT-*`** (unless **`--skip-lint`**). |
| **`--policies-require-signed`** | Require a signed PolicyPack manifest (`archrad-policy-pack.sha256`). See [Signed PolicyPacks](#signed-policypacks). |
| **`--cosign-pubkey <path>`** | Verify the manifest's cosign signature. Implies `--policies-require-signed`. |
| **`--fail-on-warning`** | Exit **1** if any warning (or structural error). |
| **`--max-warnings <n>`** | Exit **1** if warning count **>** `n`. |
| **`--fail-on <mode>`** | **`error`** (default) \| **`warning`** \| **`never`** — GitHub Actions style; when set, overrides **`--fail-on-warning`** / **`--max-warnings`**. **`never`** always exits **0**. Applies **only** to IR-STRUCT-*, IR-LINT-*, and merged PolicyPack findings — **not** to IR-DRIFT-IMPL-*. |
| **`--codebase <path>`** | Source root for reconstruction; emits **IR-DRIFT-IMPL-*** by comparing authored IR to heuristic signals from scanned files. |
| **`--codebase-language <lang>`** | **`auto`** \| **`nodejs`** \| **`python`** \| **`csharp`** — override language detection for **`--codebase`**. |
| **`--codebase-exclude <pattern>`** | Extra path fragment excluded from **`--codebase`** scans (repeatable). |
| **`--impl-drift-fail-on <mode>`** | **`error`** (default) \| **`warning`** \| **`never`** — exit policy **only** for **IR-DRIFT-IMPL-*** (independent from **`--fail-on`** above). |
| **`--report <path>`** | Write a self-contained **HTML** report of all findings. |
| **`--metrics-file <path>`** | Write **`findingsCount`**, **`errorCount`**, **`warningCount`**, **`infoCount`** as JSON (for CI outputs). |
| **`--findings-json-out <path>`** | Write the findings array as JSON (same shape as **`--json`** on stdout); still prints pretty logs unless **`--json`**. |

```bash
archrad validate --ir ./graph.json
archrad validate --ir ./graph.json --json
archrad validate --ir ./graph.json --skip-lint
archrad validate --ir ./graph.json --codebase ./src --report findings.html
archrad validate --ir ./graph.json --fail-on never --report violations.html --metrics-file metrics.json
```

With **`codebase:`** in **`archrad.yml`**, `archrad validate` runs implementation drift automatically (see **`CONFIG.md`**).

---

## `archrad reconstruct`

Reconstruct an IR graph from a real codebase (best-effort file scanning; no subprocess). Use standalone to inspect detected artifacts, or pair with **`archrad validate --codebase`** for IR-DRIFT-IMPL-* governance.

| Option | Description |
|--------|-------------|
| **`-f, --from <path>`** | Codebase root directory (required; default from **`codebase:`** in config when set). |
| **`-o, --output <path>`** | Write reconstructed IR JSON (default: **`reconstructed-ir.json`**; honours **`output:`** in config). |
| **`--language <lang>`** | **`auto`** \| **`nodejs`** \| **`python`** \| **`csharp`** — override auto-detection (config key: **`codebaseLanguage`**). |
| **`--exclude <pattern>`** | Extra path fragment to exclude from scanning (repeatable; config key: **`codebaseExclude`**). |
| **`--dry-run`** | Print reconstructed IR JSON to **stdout**; do not write a file. |
| **`--verbose`** | Print detected artifacts to **stderr**. |

```bash
archrad reconstruct --from ./src --output reconstructed-ir.json
archrad reconstruct --from ./src --language python --dry-run
archrad reconstruct --from ./src --verbose --exclude vendor
```

---

## `archrad scan`

Scan a repository and emit a **DRAFT IR** from structural signals — topology
(`docker-compose.yml`, Kubernetes, Terraform), interface (OpenAPI/Swagger),
manifests (`package.json`, `requirements.txt`, `go.mod`, `pom.xml`), and
shallow code analysis. Every node/edge carries
`config.provenance[]` (`inferred_from: file:line`, `confidence`, `extractor`) and
the graph is marked `metadata.status: "draft"` — review and edit it, don't
author from scratch. Deterministic: same repo in → byte-identical IR out; no
network calls, no LLM.

Confidence is graded by source: `compose` / `kubernetes` (high) > `openapi` /
`terraform` (medium) > `manifest` / `code` (low). Overlap across extractors is expected — a
confidence-aware merge unions matching nodes instead of erroring, keeping the
highest-confidence body and all contributing provenance.

| Option | Description |
|--------|-------------|
| **`[path]`** | Repository root to scan (default: **`.`**). |
| **`-o, --out <path>`** | Write draft IR JSON (default: print to **stdout**). |
| **`--extractors <list>`** | Comma-separated extractors to enable (default: all four). |
| **`--exclude <pattern>`** | Path fragment to exclude from scanning (repeatable). |
| **`--scope production\|all`** | **`production`** (default) excludes conventional tests, examples, docs, demos, Storybook stories, and spec/test source files. Use **`all`** when those artifacts are intentionally part of the architecture under review. |
| **`--dry-run`** | Print draft IR JSON to **stdout**; do not write a file. |
| **`--verbose`** | Print per-extractor and warning details to **stderr**. |

```bash
archrad scan . --dry-run
archrad scan ./server --out draft.ir.json --verbose
archrad scan . --extractors compose,manifest
archrad scan . --scope all --out full-repository-draft.ir.json
```

---

## `archrad lint`

Run **architecture lint only** (**`IR-LINT-*`** + PolicyPacks). Thin, fast inner-loop alternative to `archrad validate` that **skips IR structural pre-checks** — use `archrad validate` once your graph shape is stable, then iterate on lint with this command. Unparseable IR still surfaces blockers (never a silent pass).

| Option | Description |
|--------|-------------|
| **`-i, --ir <path>`** | IR JSON file (required; honours **`archrad.yml`**). |
| **`--json`** | Print findings as a JSON array on **stdout**. |
| **`--policies <dir>`** | PolicyPack YAML/JSON directory; merged after built-in **`IR-LINT-*`**. |
| **`--rule <code>`** | Only include findings matching this rule code (repeatable; case-insensitive). |
| **`--fail-on-warning`** | Exit **1** if any warning. |
| **`--max-warnings <n>`** | Exit **1** if warning count **>** `n`. |
| **`--fail-on <mode>`** | **`error`** (default) \| **`warning`** \| **`never`** — GitHub Actions style; overrides `--fail-on-warning` / `--max-warnings` when set. |
| **`--report <path>`** | Self-contained **HTML** report. |
| **`--metrics-file <path>`** | Write finding counts as JSON. |
| **`--findings-json-out <path>`** | Write findings array as JSON. |

```bash
archrad lint --ir ./graph.json                             # fast iteration
archrad lint --ir ./graph.json --fail-on warning           # CI gate
archrad lint --ir ./graph.json --rule IR-LINT-MISSING-AUTH-010   # focus on one rule
```

With an `archrad.yml` at repo root (see [`CONFIG.md`](CONFIG.md)), `archrad lint` needs **no flags** — `ir:`, `policies:`, `failOn:`, etc. are picked up automatically.

### Signed PolicyPacks

`archrad lint`, `archrad validate`, `archrad export`, and `archrad validate-drift` all accept:

| Option | Description |
|--------|-------------|
| **`--policies-require-signed`** | Require an `archrad-policy-pack.sha256` manifest next to the policy files; every file must hash-match. |
| **`--cosign-pubkey <path>`** | Also verify `archrad-policy-pack.sha256.sig` with the given cosign public key before checking the manifest. Implies `--policies-require-signed`. Requires `cosign` on `PATH`. |

Generate the manifest with [`archrad policies-sha256`](#archrad-policies-sha256).

---

## `archrad explain <code>`

Print canonical guidance for a rule code (**`IR-STRUCT-*`**, **`IR-LINT-*`**, **`DRIFT-*`**, **`IR-DRIFT-IMPL-*`**). Same text the linter surfaces in findings, pulled from the deterministic registry — use this to get an explanation without running a lint pass. Unknown codes print a "did you mean" hint.

| Option | Description |
|--------|-------------|
| **`<code>`** (positional) | Rule code to explain, e.g. **`IR-LINT-DIRECT-DB-ACCESS-002`** (case-insensitive). |
| **`--json`** | Machine-readable JSON (`{ code, title, remediation, docsUrl, layer }`). |
| **`--list`** | List every known rule code grouped by layer. Combine with **`--json`** for a structured dump. |

```bash
archrad explain IR-LINT-DIRECT-DB-ACCESS-002
archrad explain ir-lint-missing-auth-010 --json
archrad explain --list                          # every known code
archrad explain --list --json                   # structured dump
```

---

## `archrad policies-sha256`

Generate a deterministic `archrad-policy-pack.sha256` manifest for a PolicyPack directory. Manifest format mirrors `sha256sum`: `<64-char-hex>  <filename>`, one line per policy file, sorted by filename.

| Option | Description |
|--------|-------------|
| **`-d, --dir <dir>`** | Policies directory containing `*.yaml` / `*.yml` / `*.json` (required). |
| **`-o, --out <path>`** | Write manifest to this path (default: `<dir>/archrad-policy-pack.sha256`). Use **`-`** for stdout. |

```bash
# Generate a manifest in the policies directory:
archrad policies-sha256 --dir ./policies

# Optional cosign signature for air-gapped / enterprise CI:
cosign sign-blob --yes \
  --output-signature ./policies/archrad-policy-pack.sha256.sig \
  ./policies/archrad-policy-pack.sha256

# Enforce in CI:
archrad validate --ir ./graph.json --policies ./policies \
  --policies-require-signed --cosign-pubkey ./release.pub
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
