# @archrad/deterministic

<!--
  README GIF: from `packages/deterministic` run `vhs scripts/record-demo.tape` → writes `demo.gif`.
  Then add a line below this comment, e.g. ![Demo: archrad export](demo.gif)
-->

**For AI agents / IDE assistants:** see **`llms.txt`** in this package (llms.txt-style project summary for tools like Claude Code, Devin, etc.).

**Apache-2.0** — a **deterministic compiler and linter for system architecture**: blueprint **IR** (JSON graph) → **FastAPI** or **Express** + **OpenAPI**, **Docker**, **Makefile** — **no LLM**, **no account**, **offline**.

**OSS positioning:** *Includes structural validation + basic architecture linting (rule-based, deterministic).*

> This is not only a generator: **`archrad validate`** treats your graph like source code — **IR-STRUCT-*** (shape/refs/cycles) and **IR-LINT-*** (light architecture heuristics: health routes, fan-out, sync chains, HTTP→DB coupling). Then **`archrad export`** compiles to runnable projects. Generated **OpenAPI** gets a **document-shape** pass (parse + required fields — **not** Spectral-style spec lint).

**Open core (OSS):** **IR structural validation**, **basic architecture lint** (rule-based, deterministic), **OpenAPI document-shape** checks. **ArchRad Cloud** adds **policy / compliance**, deeper **architecture intelligence**, and **AI remediation** — see **`docs/STRUCTURAL_VS_SEMANTIC_VALIDATION.md`**.

---

## How it works (architecture)

```
IR (nodes/edges)  →  validateIrStructural (IR-STRUCT-*)  →  errors block export
                           ↓
                    validateIrLint (IR-LINT-*)  →  warnings (CI: --fail-on-warning / --max-warnings)
                           ↓
              pythonFastAPI | nodeExpress generators
                           ↓
              openapi.yaml + app code + package metadata
                           ↓
              golden layer (Dockerfile, docker-compose.yml, Makefile, README; host→container e.g. 8080:8080)
                           ↓
              validateOpenApiInBundleStructural(openapi.yaml)  →  document-shape warnings (not full API lint)
                           ↓
              { files, openApiStructuralWarnings, irStructuralFindings, irLintFindings }
```

### Validation levels (quick contract)

1. **JSON Schema validation** — IR document shape vs `schemas/archrad-ir-graph-v1.schema.json` (editor/CI; optional at runtime).
2. **IR structural validation** — `validateIrStructural`: arrays, ids, HTTP `config`, edge refs, cycles (`IR-STRUCT-*`). Uses an internal **normalized** graph (see **`docs/IR_CONTRACT.md`**).
3. **Export-time generated OpenAPI structural validation** — Parse + required fields on the **generated** `openapi.yaml` (document shape, not Spectral).

**Architecture lint** (`IR-LINT-*`) sits after structural checks: rule visitors on the parsed graph (heuristics, not schema).

### Validation layers (naming)

| Layer (OSS) | What it is | Codes |
|-------------|------------|--------|
| **IR structural validation** | Graph well-formedness: ids, edges, cycles, HTTP path/method | `IR-STRUCT-*` |
| **Architecture lint (basic)** | Deterministic heuristics only (no AI, no org policy) | `IR-LINT-*` |
| **OpenAPI structural validation** (document shape) | Parse + required top-level OpenAPI fields on **generated** spec | *(string warnings, not IR codes)* |

| Layer (Cloud — not this package) | Examples |
|----------------------------------|----------|
| **Policy engine** | SOC2, org rules, entitlement |
| **Architecture intelligence** | Deeper NFR / cost / security reasoning |
| **AI remediation** | Repair loops, suggested edits |

1. **IR structural validation:** duplicate/missing node ids, bad HTTP `config.url` / `config.method`, unknown edge endpoints, directed cycles.
2. **Architecture lint:** Implemented as a **registry of visitor functions** on a parsed graph (`buildParsedLintGraph` → **`LINT_RULE_REGISTRY`** in **`src/lint-rules.ts`**). Each rule returns **`IrStructuralFinding[]`**; **`runArchitectureLinting`** / **`validateIrLint`** flatten them. Add a rule by writing `(g) => findings` and pushing onto the registry. Codes include **IR-LINT-DIRECT-DB-ACCESS-002**, **IR-LINT-SYNC-CHAIN-001**, **IR-LINT-NO-HEALTHCHECK-003**, **IR-LINT-HIGH-FANOUT-004**. Sync-chain today treats **all** resolved edges as synchronous (no **`edge.metadata.protocol`** required); you can add a metadata-filtered rule alongside the registry if your IR encodes async/sync on edges.
3. **Generators** → `openapi.yaml`, handlers, deps.
4. **Golden path** → `make run` / `docker compose up --build`.
5. **OpenAPI document shape** on the bundle — **not** [Spectral](https://github.com/stoplightio/spectral)-level lint. Issues → **`openApiStructuralWarnings`**.

**IR contract:** **`schemas/archrad-ir-graph-v1.schema.json`**. **Parser boundary + normalized shapes:** **`docs/IR_CONTRACT.md`** (`normalizeIrGraph` → `materializeNormalizedGraph`).

**Trust builder:** **IR-STRUCT-*** errors block export; **IR-LINT-*** warnings are visible and can **gate CI** via **`--fail-on-warning`** / **`--max-warnings`**; OpenAPI shape issues surface as export warnings.

### Codegen vs validation (retry, timeouts, policy)

Generators **may emit** retry/timeout/circuit-breaker **code** when the IR carries matching edge or node config (e.g. `retryPolicy`). That is **code generation**, not a guarantee. OSS does **not** currently **require** or **lint** “every external call must have timeout/retry” — that class of rule is **semantic / policy** and fits **ArchRad Cloud** or custom linters on top of the IR.

---

## Ways to use it

| Mode | Best for | Example |
|------|-----------|---------|
| **CLI** | Quick local scaffolding, CI, “no Node project” usage | `archrad export --ir graph.json --target python --out ./out` |
| **CLI validate** | CI / pre-commit: IR structural + architecture lint, no codegen | `archrad validate --ir graph.json` |
| **Library** (`@archrad/deterministic`) | IDPs / pipelines | `runDeterministicExport` → files + `irStructuralFindings` + `irLintFindings` |

### CLI

**Input is structured IR (JSON), not natural language.** There is no `archrad export --prompt "..."`. You pass a **graph file** (nodes/edges) like **`fixtures/minimal-graph.json`**. For a graph that is structurally valid but hits every **architecture lint** rule at once, use **`fixtures/ecommerce-with-warnings.json`** (`archrad validate --ir fixtures/ecommerce-with-warnings.json`). To go from **plain English → IR**, use **ArchRad Cloud** or your own LLM step; this package only does **IR → files**.

After `npm run build` (or `npm install`, which runs `prepare`):

```bash
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./my-api
# After global install / npx:
archrad export --ir ./graph.json --target node --out ./my-express-api

# Validate IR (structural + architecture lint). Pretty output; exit 1 on structural errors by default:
node dist/cli.js validate --ir fixtures/minimal-graph.json
# Machine-readable + CI gates:
archrad validate --ir ./graph.json --json
archrad validate --ir ./graph.json --fail-on-warning
archrad validate --ir ./graph.json --max-warnings 0
# Structural only (skip IR-LINT-*):
archrad validate --ir ./graph.json --skip-lint
```

#### Example: validate architecture

```bash
archrad validate --ir fixtures/minimal-graph.json
```

Example output (stderr):

```text
archrad validate:
⚠️ IR-LINT-NO-HEALTHCHECK-003: No HTTP node exposes a typical health/readiness path (...)
   Fix: Add a GET route such as /health for orchestrators and load balancers.
   Suggestion: Expose liveness vs readiness separately if your platform distinguishes them.
   Impact: Weaker deploy/rollback safety and harder operations automation.
```

Structural errors look like **`❌ IR-STRUCT-...`** with **`Fix:`** lines. Use **`--json`** to consume findings in GitHub Actions or other CI.

- **`--ir`** — JSON: `{ "graph": { "nodes", "edges", "metadata" } }` or a raw graph (CLI wraps it).
- **`--target`** — `python` \| `node` \| `nodejs`
- **`--out`** — output directory (created if needed)
- **`--host-port <n>`** — host port Docker publishes (default **8080**; container still listens on **8080** inside). Same as env **`ARCHRAD_HOST_PORT`**.
- **`--skip-host-port-check`** — don’t probe `127.0.0.1` before export.
- **`--strict-host-port`** — **exit with error** if the host port appears **in use** (CI-friendly).
- **`--skip-ir-structural-validation`** — skip **`validateIrStructural`** before export (debug only; not recommended).
- **`--skip-ir-lint`** — skip **`validateIrLint`** during export.
- **`--fail-on-warning`** / **`--max-warnings <n>`** — if set, **no files are written** when IR structural + lint findings violate the policy (same semantics as **`validate`**).

By default, if **8080** (or your `--host-port`) looks **busy** on localhost, the CLI **warns** so you can change the port before `docker compose` fails with a bind error.

**Export** runs **IR structural validation**, then **architecture lint**, then codegen. **Structural errors** abort with **no files written**. **Lint warnings** print by default; use **`--fail-on-warning`** / **`--max-warnings`** to block writes for CI.

### Validate the package as a developer

1. `cd packages/deterministic && npm ci && npm run build && npm test`
2. `node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./tmp-out`
3. `cd tmp-out && make run` then `curl` the URL shown in the generated **README** (port matches `--host-port` if you set it).
4. Optional: `node dist/cli.js export ... --host-port 18080` if **8080** is already taken.

### Library

```typescript
import {
  runDeterministicExport,
  validateIrStructural,
  validateIrLint,
  sortFindings,
  shouldFailFromFindings,
} from '@archrad/deterministic';

const { files, openApiStructuralWarnings, irStructuralFindings, irLintFindings } =
  await runDeterministicExport(ir, 'python', {
    hostPort: 8080,
    skipIrLint: false, // default
  });
// Structural errors → empty files (unless skipIrStructuralValidation). Lint is non-blocking for export unless you check policy in your pipeline.

const all = sortFindings([...validateIrStructural(ir), ...validateIrLint(ir)]);
if (shouldFailFromFindings(all, { failOnWarning: true })) {
  /* gate your CI */
}
```

Optional: `isLocalHostPortFree` / `normalizeGoldenHostPort` from the same package if you want your own preflight.

---

## Golden path (~60 seconds)

From the package root (after build):

```bash
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./out
cd ./out
make run
# In another terminal, once the API is up:
curl -sS -X POST http://localhost:8080/signup -H "Content-Type: application/json" -d '{}'
```

You should see **422 Unprocessable Entity** (FastAPI/Pydantic) or **400** with a clear body — proof the stack is live and validation matches the spec, not a silent 500.

**Helper script** (prints the same flow; use when recording a terminal GIF):

```bash
bash scripts/golden-path-demo.sh
```

See **`scripts/README_DEMO_RECORDING.md`** for **VHS / asciinema / ttyrec** tips to capture a GIF for the top of this README.

---

## Open source vs ArchRad Cloud

**This repository is only the deterministic engine** — local, offline, no phone-home.

| Here (OSS) | ArchRad Cloud (commercial product) |
|------------|-------------------------------------|
| IR **structural** + **architecture lint** (`validate`, `IR-STRUCT-*`, `IR-LINT-*`), compiler (`export`), OpenAPI **document-shape** warnings, golden Docker/Makefile | **Policy engine**, deeper **architecture intelligence**, **AI remediation** |
| `archrad` CLI forever, no account required for this package | Auth, orgs, **quotas**, billing |
| No proprietary **LLM** orchestration or “repair” loops | LLM generation, repair, multi-model routing |
| No Git sync, no enterprise policy injection in this repo | Git push, governance, compliance dashboards |

You can depend on this CLI and library **without** ArchRad Cloud. The cloud product stacks collaboration and AI on top of the same deterministic contract.

**InkByte vs this package:** Deeper workflow analysis, enterprise validation routes, and LLM-assisted flows may exist in the **private InkByte monorepo** (`server/`, etc.); they are **not** part of the **`@archrad/deterministic`** npm surface unless shipped here. This README describes **only** what the OSS package proves.

---

## Monorepo vs public OSS repo

The **canonical source** for this engine may live in a **private monorepo** next to the full product; `server` can depend on `file:../packages/deterministic`. The **public** GitHub repo should contain **only** this package — canonical clone: **`https://github.com/archradhq/arch-deterministic`**. Subtree publish: **`docs/OSS_VS_PRODUCT_REPOS.md`** and **`docs/PUBLISH_DETERMINISTIC_OSS.md`** (in the product monorepo).

---

## Publishing the public OSS repo

From the private monorepo root: **`docs/PUBLISH_DETERMINISTIC_OSS.md`**. This tree includes **`.github/workflows/ci.yml`** and **Dependabot**; they run when this folder is the **git root** of the public repo.

---

## Contributing

See **`CONTRIBUTING.md`**.

---

## License

Apache-2.0 — see **`LICENSE`**.
