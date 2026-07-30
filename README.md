# @archrad/deterministic

![archrad validate — IR-LINT-DIRECT-DB-ACCESS-002 first, fix on the graph, clean gate](demo-validate.gif)

![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue) ![no LLM](https://img.shields.io/badge/no%20LLM-deterministic-green) ![no account](https://img.shields.io/badge/no%20account-offline-lightgrey)

Your architecture drifts before you write a single line of code. `archrad validate` catches it — deterministically, in CI, before the PR merges.

Define your system as a graph. ArchRAD compiles it, lints it against architecture rules, and tells you exactly what's wrong — with rule codes, not opinions.

---

## Quick start (60 seconds)

```bash
npm install -g @archrad/deterministic
archrad validate --ir fixtures/demo-direct-db-violation.json
```

You should see something like (exact wording may vary slightly by version):

```
⚠️ IR-LINT-DIRECT-DB-ACCESS-002: API node "orders-api" connects directly to datastore node "orders-db"
   Fix: Introduce a service or domain layer between HTTP handlers and persistence.
```

For a smaller graph (single endpoint, no DB edge), try **`fixtures/minimal-graph.json`** — you will get different warnings (e.g. health/auth heuristics), not **`IR-LINT-DIRECT-DB-ACCESS-002`**.

No IR file yet? Cold-start from an existing OpenAPI spec:

```bash
archrad ingest openapi --spec ./openapi.yaml --out ./graph.json
archrad validate --ir ./graph.json
```

Or point at a real repo and let `archrad scan` draft one for you to review:

```bash
archrad scan . --out draft.ir.json
archrad validate --ir ./draft.ir.json
```

---

## What it does

ArchRAD is a blueprint compiler and governance layer. You define your architecture as an IR — nodes, edges, allowed connections — and ArchRAD validates it against a deterministic rule engine. The same IR, the same rules, the same inputs always produce the same findings.

| Command | What it checks | Codes |
|---------|---------------|-------|
| `archrad validate` | Graph structure + architecture lint | `IR-STRUCT-*` `IR-LINT-*` |
| `archrad lint` | Architecture lint only (fast inner-loop; skips structural) | `IR-LINT-*` |
| `archrad explain <code>` | Canonical rule guidance without running a pass | — |
| `archrad policies-sha256 --dir <policies>` | Generate a `archrad-policy-pack.sha256` manifest for signed PolicyPacks | — |
| `archrad validate-drift` | IR vs generated code on disk | `DRIFT-*` |
| `archrad scan` | Draft IR from a repo — topology, OpenAPI, manifests, code; every node cited + graded by confidence | — |
| `archrad reconstruct` | Draft IR from source code alone (one of `scan`'s four signal sources, usable standalone) | — |
| `archrad ingest openapi` | Derive IR from OpenAPI (local path or https URL for `--spec`; `-H` for URL auth headers) | — |
| `archrad ingest backstage` | Backstage `catalog-info.yaml` → IR (Component, Resource, API, System; Location file targets) | — |
| `archrad fragment merge` | Merge 2+ IR files — union by `node.id` (conflicts → stderr); `--prefix-fragments` for disjoint union | — |
| `archrad export` | Compile IR → FastAPI or Express + Docker | — |

**Ingest + merge workflows:** **`docs/INGEST.md`**. **All commands / flags:** **`docs/CLI_REFERENCE.md`**. **Codegen (`export`):** **`docs/EXPORT.md`**.

---

## Draft an IR from a real repo (`archrad scan`)

`archrad scan` points at a repository and emits a **draft IR** — never a final
answer, always something to review and edit. It runs four extractors, graded by
how much they have to guess:

| Source | Signal | Confidence |
|--------|--------|------------|
| Topology | `docker-compose.yml` | high — a declaration, not a guess |
| Interface | OpenAPI / Swagger | medium — documents a real surface, but only what's documented |
| Manifest | `package.json`, `requirements.txt` | low — a driver dependency implies an edge, not proof it's used |
| Code | pattern scan of source (Node.js/TS, Python, C#) | low — regex over text, no semantic understanding |

Every node and edge carries `config.provenance[]` — `inferred_from: "file:line"`,
a `confidence`, and which extractor found it — so nothing has to be taken on
faith. When two extractors describe the same thing, `scan` merges them (keeping
the highest-confidence body, unioning all provenance) instead of duplicating or
erroring.

```bash
archrad scan . --dry-run                       # print the draft, write nothing
archrad scan ./server --out draft.ir.json       # write it
archrad scan . --extractors compose,manifest    # only run specific extractors
```

The output is a normal IR file — pipe it straight into `archrad validate` once
you've reviewed it. Full flags: **`docs/CLI_REFERENCE.md`**.

---

## Implementation governance (`archrad reconstruct` + `--codebase`)

> "The IR looks clean — but is that what was actually shipped?"

The validation pipeline above checks your **authored IR** (the design contract). The `--codebase` flag bridges the gap to the **real codebase** by reconstructing an IR from source code and comparing them.

### The "dummy IR" attack — and how to catch it

A developer can author a compliant IR (passes all IR-STRUCT-* and IR-LINT-* rules) while the actual code bypasses the documented architecture. The most dangerous pattern: an IR that shows a clean service layer but code that directly queries the database.

```bash
# Catch discrepancies between the authored design and the shipped code
archrad validate --ir authored-ir.json --codebase ./src --report findings.html
```

When `--codebase` is provided, the pipeline runs three stages:
1. IR-STRUCT-* structural validation on the authored IR
2. IR-LINT-* architecture lint on the authored IR
3. IR-DRIFT-IMPL-* comparison of authored IR vs reconstructed codebase IR

### IR-DRIFT-IMPL-* rules

Implementation drift uses a **separate exit threshold**: **`--fail-on`**, **`--fail-on-warning`**, and **`--max-warnings`** apply only to IR-STRUCT-*, IR-LINT-*, and merged PolicyPack findings. **IR-DRIFT-IMPL-*** are gated solely by **`--impl-drift-fail-on`** (default: drift severities **`error`** fail the command).

| Code | Severity | What it catches |
|------|----------|----------------|
| `IR-DRIFT-IMPL-000` | warning | Authored IR could not be parsed for drift comparison (fix structural issues first) |
| `IR-DRIFT-IMPL-001` | warning | IR declares HTTP-like entry nodes but reconstruction detected **zero** artifacts in `--codebase` |
| `IR-DRIFT-IMPL-002` | warning | HTTP / health routes in code but authored IR has **no** HTTP-like nodes |
| `IR-DRIFT-IMPL-003` | **error** | Direct DB connection in code, no DB edge in authored IR |
| `IR-DRIFT-IMPL-004` | **error** | HTTP route in code not present in authored IR |
| `IR-DRIFT-IMPL-005` | warning | Service-to-service call in code, no edge in authored IR |
| `IR-DRIFT-IMPL-006` | info | Auth middleware in code, no auth node in authored IR |

`IR-DRIFT-IMPL-003` is the critical one. An error there means the authored IR hides a direct DB dependency.

### Reconstruct standalone

```bash
# Just reconstruct — write the IR without comparing
archrad reconstruct --from ./src --output reconstructed-ir.json

# Force language detection
archrad reconstruct --from ./src --language python --output py-ir.json

# Print to stdout (dry-run)
archrad reconstruct --from ./src --dry-run

# Show every detected artifact
archrad reconstruct --from ./src --verbose
```

### Supported languages

| Language | Detected patterns |
|----------|-------------------|
| **Node.js / TypeScript** | Express, Fastify, NestJS routes + controllers; BullMQ workers, Agenda jobs, cron schedules; pg, Prisma, TypeORM, Sequelize, Mongoose, Redis, BullMQ, Firebase; Passport, express-jwt, NestJS guards, Auth0, Okta, Keycloak, Cognito; axios, got, node-fetch, gRPC; outbound HTTP URLs extracted per destination |
| **Python** | Flask, FastAPI, Django URLs, DRF @action; SQLAlchemy, psycopg2, asyncpg, PyMongo, motor, redis-py; login_required, jwt_required, FastAPI OAuth2; requests, httpx, aiohttp, gRPC |
| **C#** | Minimal API MapGet/MapPost; ASP.NET Core [HttpGet]/[ApiController]; EF Core DbContext, Npgsql, Dapper; [Authorize], AddAuthentication, JWT bearer; HttpClient, gRPC, RestSharp |

### Service decomposition (Node.js)

The reconstructor detects service boundaries and creates **one node per service** rather than collapsing everything into a single gateway:

| Layout | Detection signal | Result |
|--------|-----------------|--------|
| Files in `routes/` or `controllers/` directory | `router.get/post/…` in dedicated file | One `service` node per file |
| NestJS controllers | `@Controller` decorator / `*.controller.ts` naming | One `service` node per controller file |
| Entry file with `app.listen()` | Mounts other routers | `gateway` node |
| BullMQ / Agenda / cron files | `new Worker(…)`, `agenda.define(…)` | `worker` node |
| Monolithic file (all routes in one file) | Single file, no `routes/` dir | Single `gateway` node — **no forced split** |

Edges between nodes reflect what the reconstruction found:
- **gateway → service** edges are added for all decomposed services.
- **service → database** edges appear only when the route file itself contains a DB import or env var reference (not when DB access is hidden behind a shared utility module).

### Node naming

DB and cache nodes use the most user-recognizable name available:

1. **Env var name** — `process.env.REDIS_URL` → node named `"redis"`, `process.env.SESSION_REDIS_URL` → `"session-redis"`
2. **Connection variable name** — `const userDb = new Pool(…)` → node named `"userDb"` (for unique variable names)
3. **Library / driver name** — fallback when no env var or named variable is detectable

Node IDs and names never include `env_var` or other detection-method metadata.

### External service identification

Outbound HTTP/gRPC calls create **distinct external nodes** per destination:

- `axios.post('https://api.stripe.com/…')` → node `"stripe"`
- `fetch('https://auth0.com/oauth/token')` → node `"auth0"`
- `new PaymentServiceClient('payments-svc:50051')` → node `"payment"` (gRPC)
- Generic fallback for clients without a detectable URL: one shared `"external-service"` node

### Honest scope limits

Reconstruction is **best-effort signal, not certainty**:

1. **Dynamic patterns** — `eval`, reflection, metaprogramming, and generated code are not detected.
2. **Runtime config** — topology decisions made at runtime (feature flags, config-driven routing) cannot be statically analyzed.
3. **Cross-language services** — a single codebase containing multiple language runtimes reduces accuracy.
4. **Heavy abstractions** — macro-based or annotation-processor-heavy frameworks may obscure routes or connections.
5. **Shared data access layers** — when DB connections live in a shared utility file (e.g., `db.ts`, `firebaseAdmin.ts`) rather than the route files themselves, those connections are **not linked to individual service nodes**. The reconstructed IR honestly omits edges it cannot trace statically.

### Interpreting lint findings on reconstructed IR

Run `archrad validate` on a reconstructed IR and you may see:

| Finding | On reconstructed IR | Interpretation |
|---------|-------------------|----------------|
| `IR-LINT-DEAD-NODE-011` (service node, no outgoing edges) | Expected when services use a shared data-access layer | Not a real problem; the route files have no directly-detected downstream edges |
| `IR-LINT-HIGH-FANOUT-004` on gateway | Expected for large monorepos | The gateway→service edge count reflects the route file count |
| `IR-LINT-DIRECT-DB-ACCESS-002` on gateway | Real finding | A route in the entry file directly accesses a DB without a service layer |
| `IR-LINT-NO-HEALTHCHECK-003` | May fire if health endpoint is in a separate `routes/health.ts` service node | Check whether the health route is reachable from the entry point |

**`IR-LINT-DIRECT-DB-ACCESS-002` on reconstructed IR is the high-signal rule**: if it fires on a `gateway` node, it means the entry file itself has direct DB access (not delegated to a service layer). If the decomposition correctly identified service nodes between the gateway and the database, this rule should be silent.

> **Treat reconstructed IR as a draft for human review, not as ground truth.** Use it to catch obvious drift between authored architecture and actual code, not as an authoritative picture of the system.

Treat IR-DRIFT-IMPL-* findings as **"review required"**, not absolute truth. The reconstructed IR is signal, not certainty.

### Worked example — catching a "dummy IR"

Authored IR (`authored.json`) shows clean layered architecture:
```json
{ "graph": { "nodes": [
  { "id": "api", "type": "gateway", "name": "API" },
  { "id": "svc", "type": "service", "name": "Order Service" },
  { "id": "db", "type": "postgres", "name": "Orders DB" }
], "edges": [
  { "from": "api", "to": "svc" },
  { "from": "svc", "to": "db" }
]}}
```

But `src/api/routes.ts` contains:
```typescript
import { Pool } from 'pg';
const db = new Pool({ connectionString: process.env.DATABASE_URL });
// direct DB query in the route handler — bypasses the service layer
app.get('/orders', async (req, res) => res.json(await db.query('SELECT * FROM orders')));
```

Running `archrad validate --ir authored.json --codebase ./src`:
```
❌ IR-DRIFT-IMPL-003: Direct database connection(s) detected in code (pg (PostgreSQL) → postgres) but no DB edges exist in the authored IR
   Fix: Either add the missing DB edges to the authored IR, or confirm the codebase points to the correct service.
   Suggestion: This discrepancy is a governance red flag: the authored IR could be masking a direct DB dependency.
   Impact: CRITICAL — this pattern is exploited in "dummy IR" attacks where clean design docs conceal direct database access in shipped code.
```

The IR said no direct DB access. The code said otherwise. `IR-DRIFT-IMPL-003` caught the gap.

## Project config (`archrad.yml`)

Drop an `archrad.yml` at the root of your repo and skip re-typing flags:

```yaml
# archrad.yml
ir: ./archrad-graph.json
target: python
output: ./generated
failOn: warning
policies: ./policies
```

```bash
archrad validate          # uses ir, failOn, policies
archrad export            # uses ir, target, output
archrad validate-drift    # uses ir, target, output
```

`archrad` walks upward from the CWD looking for `archrad.yml` (or
`archrad.yaml`). Explicit CLI flags always override the config. Use
`--no-config` to ignore any discovered file, or `--config <path>` to
point at a non-standard location. Full schema: [docs/CONFIG.md](docs/CONFIG.md).

## Fast inner loop: `archrad lint` + `archrad explain`

```bash
# Iterate on lint without re-checking IR structure every run:
archrad lint --ir ./graph.json

# Focus on a single rule while fixing it:
archrad lint --ir ./graph.json --rule IR-LINT-MISSING-AUTH-010

# Understand a rule code without running a pass:
archrad explain IR-LINT-DIRECT-DB-ACCESS-002
archrad explain --list                  # every known rule code
```

`archrad lint` is the fast inner loop; use `archrad validate` once before the CI gate to also enforce IR structural shape. With `archrad.yml` at repo root, both run with no flags.

## CI integration

```bash
# Fail on any structural error (default):
archrad validate --ir ./graph.json

# Also fail on lint warnings:
archrad validate --ir ./graph.json --fail-on-warning

# Machine-readable output for GitHub Actions:
archrad validate --ir ./graph.json --json
```

## MCP server (Cursor / Claude Desktop)

After install, `archrad-mcp` is on your PATH. Add it to your IDE:

```json
{
  "mcpServers": {
    "archrad": { "command": "archrad-mcp" }
  }
}
```

Your agent can call the same engine as the CLI via **six** MCP tools (e.g. `archrad_validate_ir`, `archrad_lint_summary`, `archrad_validate_drift`, `archrad_policy_packs_load`, `archrad_list_rule_codes`, `archrad_suggest_fix`). See [docs/MCP.md](docs/MCP.md) for parameters and local testing.

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

  Optional CI: archrad validate-drift  →  re-export IR in-memory, diff vs existing ./out  →  DRIFT-MISSING / DRIFT-MODIFIED (thin deterministic gate)
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
2. **Architecture lint:** Implemented as a **registry of visitor functions** on a parsed graph (`buildParsedLintGraph` → **`LINT_RULE_REGISTRY`** in **`src/lint-rules.ts`**). If the IR cannot be parsed, **`buildParsedLintGraph`** returns **`{ findings }`** (IR-STRUCT-*) instead of **`null`**; use **`isParsedLintGraph()`** or call **`validateIrLint`**, which forwards those findings. Each rule returns **`IrStructuralFinding[]`**; **`runArchitectureLinting`** / **`validateIrLint`** flatten them. **Custom org rules:** compose **`runArchitectureLinting`** with your own **`(g) => findings`** in CI (worked example: **`docs/CUSTOM_RULES.md`**), or **fork** and append to **`LINT_RULE_REGISTRY`** if the stock **`archrad validate`** CLI must emit your codes. CLI **`archrad validate`** / **`archrad export`** print lint under **Architecture lint (IR-LINT-*)** (grouped separately from structural). Codes include **IR-LINT-DIRECT-DB-ACCESS-002**, **IR-LINT-SYNC-CHAIN-001**, **IR-LINT-NO-HEALTHCHECK-003**, **IR-LINT-HIGH-FANOUT-004**, **IR-LINT-ISOLATED-NODE-005**, **IR-LINT-DUPLICATE-EDGE-006**, **IR-LINT-HTTP-MISSING-NAME-007**, **IR-LINT-DATASTORE-NO-INCOMING-008**, **IR-LINT-MULTIPLE-HTTP-ENTRIES-009**, **IR-LINT-MISSING-AUTH-010**, **IR-LINT-DEAD-NODE-011**. **Sync-chain** depth counts **synchronous** edges only; mark message/queue/async hops via **`edge.metadata.protocol`** / **`config.async`** (see **`edgeRepresentsAsyncBoundary`** in **`lint-graph.ts`** and **`docs/ENGINEERING_NOTES.md`**).
3. **Generators** → `openapi.yaml`, handlers, deps.
4. **Golden path** → `make run` / `docker compose up --build`.
5. **OpenAPI document shape** on the bundle — **not** [Spectral](https://github.com/stoplightio/spectral)-level lint. Issues → **`openApiStructuralWarnings`**.

**IR contract:** **`schemas/archrad-ir-graph-v1.schema.json`**. **Parser boundary + normalized shapes:** **`docs/IR_CONTRACT.md`** (`normalizeIrGraph` → `materializeNormalizedGraph`).

**Trust builder:** **IR-STRUCT-*** errors block export; **IR-LINT-*** warnings are visible and can **gate CI** via **`--fail-on-warning`** / **`--max-warnings`**; OpenAPI shape issues surface as export warnings.

**Reference (OSS):** **[`docs/DRIFT.md`](docs/DRIFT.md)** (deterministic **`validate-drift`**), **[`docs/RULE_CODES.md`](docs/RULE_CODES.md)** (finding codes; MCP **`docsUrl`** targets GitHub anchors), **[`docs/MCP.md`](docs/MCP.md)** (MCP tools + local testing).

### Codegen vs validation (retry, timeouts, policy)

Generators **may emit** retry/timeout/circuit-breaker **code** when the IR carries matching edge or node config (e.g. `retryPolicy`). That is **code generation**, not a guarantee. OSS does **not** currently **require** or **lint** “every external call must have timeout/retry” — that class of rule is **semantic / policy** and fits **ArchRad Cloud** or custom linters on top of the IR.

---

## Ways to use it

| Mode | Best for | Example |
|------|-----------|---------|
| **CLI** | Quick local scaffolding, CI, “no Node project” usage | `archrad export --ir graph.json --target python --out ./out` |
| **YAML → IR** | Author graphs in YAML, emit JSON for validate/export | `archrad yaml-to-ir -y graph.yaml -o graph.json` |
| **OpenAPI → IR** | Derive HTTP nodes from OpenAPI 3.x (same IR shape as YAML path); **ArchRad Cloud** merge uses the same library | `archrad ingest openapi --spec openapi.yaml -o graph.json` |
| **CLI validate** | CI / pre-commit: IR structural + architecture lint, no codegen | `archrad validate --ir graph.json` |
| **CLI validate-drift** | After export or merges: on-disk tree vs fresh deterministic export from same IR | `archrad validate-drift -i graph.json -t python -o ./out` |
| **Library** (`@archrad/deterministic`) | IDPs / pipelines | `runDeterministicExport` → files + findings; **`runValidateDrift`** / **`runDriftCheckAgainstFiles`** for drift |
| **MCP** (`archrad-mcp`) | Cursor / Claude Desktop / other MCP hosts | stdio server: validate IR, lint summary, drift, policy packs, static **`archrad_suggest_fix`** — see **`docs/MCP.md`** |

**MCP (Cursor example):** after `npm i -g @archrad/deterministic` (or `npx`), add a server with command **`archrad-mcp`** and no args (stdio). Pass **`ir`** inline or **`irPath`** to a JSON file for large graphs. **`archrad_suggest_fix`** returns curated text for a finding code (e.g. `IR-LINT-MISSING-AUTH-010`) — not machine-generated IR patches. **Step-by-step testing** (smoke script, MCP Inspector, Cursor chat prompts): **`docs/MCP.md`**, section **Local testing**.

### CLI

**Input is structured IR (JSON), not natural language.** There is no `archrad export --prompt "..."`. Pass a **graph file** (nodes/edges).

**Fixtures** (in this repo): **`fixtures/minimal-graph.json`** (small); **`fixtures/demo-direct-db-violation.json`** / **`fixtures/demo-direct-db-layered.json`** (before/after **`IR-LINT-DIRECT-DB-ACCESS-002`**); **`fixtures/ecommerce-with-warnings.json`** (many lint rules); **`fixtures/payment-retry-demo.json`** (retry-related codegen in export). **`--target python`** is the FastAPI bundle; there is no separate `fastapi` target. To go from **plain English → IR**, use **ArchRad Cloud** or your own LLM step; this package only does **IR → files**.

**Recording demos and GIFs** (VHS, storyboards, drift replay): **`scripts/README_DEMO_RECORDING.md`** only — not required to use the CLI.

**OpenAPI → JSON (spec as source of truth):** each operation under `paths` becomes an `http` node (`config.url` + `config.method`). Then validate and export like any other IR:

```bash
archrad ingest openapi --spec ./openapi.yaml --out ./graph.json
archrad validate --ir ./graph.json
archrad export --ir ./graph.json --target python --out ./out
```

**OpenAPI security → IR → lint:** ingestion copies **global** and **per-operation** `security` requirement names onto each HTTP node as `config.security` (sorted, deterministic). An operation with explicit `security: []` becomes `config.authRequired: false` (intentionally public). If the spec declares **no** security at any level, nodes are left without those fields — then **`archrad validate`** can surface **`IR-LINT-MISSING-AUTH-010`** on HTTP-like entry nodes (compliance gap from the spec artifact alone).

**YAML → JSON (lighter authoring):** edit **`fixtures/minimal-graph.yaml`** (or your own file) and compile to IR JSON, then validate or export:

```bash
archrad yaml-to-ir --yaml fixtures/minimal-graph.yaml --out ./graph.json
archrad validate --ir ./graph.json
# or pipe: archrad yaml-to-ir -y fixtures/minimal-graph.yaml | archrad validate --ir /dev/stdin   # on Unix; on Windows use --out then validate
```

YAML must have either top-level **`graph:`** (object) or top-level **`nodes:`** (array); bare graphs are wrapped as `{ "graph": { ... } }` automatically.

**After `npm install -g` or `npx`** (typical):

```bash
archrad export --ir ./graph.json --target node --out ./my-express-api

# Validate IR (structural + architecture lint). Pretty output; exit 1 on structural errors by default:
archrad validate --ir ./graph.json
# Machine-readable + CI gates:
archrad validate --ir ./graph.json --json
archrad validate --ir ./graph.json --fail-on-warning
archrad validate --ir ./graph.json --max-warnings 0
# Structural only (skip IR-LINT-*):
archrad validate --ir ./graph.json --skip-lint
# Declarative PolicyPack YAML/JSON in a directory (after IR-LINT-*; skipped with --skip-lint):
archrad validate --ir ./graph.json --policies ./policy-packs
```

**From a git clone** (contributors): run **`npm ci && npm run build`** in the package root (there is no `prepare` hook — see **`docs/ENGINEERING_NOTES.md`**), then use **`node dist/cli.js`** the same way you would use **`archrad`** (e.g. **`node dist/cli.js validate --ir fixtures/minimal-graph.json`**).

**Deterministic drift (thin, OSS):** compare an existing export tree on disk to a **fresh** export from the same IR. Detects **missing** / **changed** generated files (line endings normalized). Optional **`--strict-extra`** flags files present on disk but not in the reference export. Not semantic “does code match intent” — **ArchRad Cloud** adds builder/UI drift checks and broader governance.

```bash
archrad export -i ./graph.json -t python -o ./out
# …edit files under ./out…
archrad validate-drift -i ./graph.json -t python -o ./out --skip-host-port-check
# CI-friendly:
archrad validate-drift -i ./graph.json -t python -o ./out --skip-host-port-check --json
# Fail if the tree has extra files not in the reference export:
archrad validate-drift -i ./graph.json -t python -o ./out --strict-extra
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
- **`--danger-skip-ir-structural-validation`** — **UNSAFE:** skip **`validateIrStructural`** before export (never in CI). **Parse/normalize failures** (invalid root, empty graph) are still detected via **`validateIrLint`** and **block** export with **`IR-STRUCT-*`** in **`irStructuralFindings`**. A hidden **`--skip-ir-structural-validation`** remains as a deprecated alias.
- **`--skip-ir-lint`** — skip **`validateIrLint`** during export.
- **`--fail-on-warning`** / **`--max-warnings <n>`** — if set, **no files are written** when IR structural + lint findings violate the policy (same semantics as **`validate`**).

By default, if **8080** (or your `--host-port`) looks **busy** on localhost, the CLI **warns** so you can change the port before `docker compose` fails with a bind error.

**Export** runs **IR structural validation**, then **architecture lint**, then codegen. **Structural errors** abort with **no files written**. **`irLintFindings`** contains only **`IR-LINT-*`**; **`IR-STRUCT-*`** from a failed parse always appear under **`irStructuralFindings`** (including when structural validation was skipped). **Lint warnings** print by default; use **`--fail-on-warning`** / **`--max-warnings`** to block writes for CI.

### Library

```typescript
import {
  runDeterministicExport,
  runValidateDrift,
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

const drift = await runValidateDrift(ir, 'python', '/path/to/existing-export', {
  skipIrLint: false, // set true to match CLI --skip-ir-lint on reference export
});
// drift.ok, drift.driftFindings, drift.exportResult — same core semantics as CLI validate-drift (CLI also probes host port before calling the library)

const all = sortFindings([...validateIrStructural(ir), ...validateIrLint(ir)]);
if (shouldFailFromFindings(all, { failOnWarning: true })) {
  /* gate your CI */
}
```

Optional: `isLocalHostPortFree` / `normalizeGoldenHostPort` from the same package if you want your own preflight.

---

## Golden path (contributors — local clone)

This path assumes you **cloned the repo** and ran **`npm ci && npm run build`** in the package root. If you only installed with **`npm install -g @archrad/deterministic`**, use **`archrad`** instead of **`node dist/cli.js`** (same flags).

```bash
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./out
cd ./out
make run
# In another terminal, once the API is up:
curl -sS -X POST http://localhost:8080/signup -H "Content-Type: application/json" -d '{}'
```

You should see **422 Unprocessable Entity** (FastAPI/Pydantic) or **400** with a clear body — proof the stack is live and validation matches the spec, not a silent 500.

Quick check from a clone: **`cd packages/deterministic && npm ci && npm run build && npm test`**, then export to **`./tmp-out`**, **`cd tmp-out && make run`**, **`curl`** as above. Use **`--host-port 18080`** (or **`node dist/cli.js export ... --host-port 18080`**) if **8080** is busy.

Optional: **`bash scripts/golden-path-demo.sh`** runs the same flow. **Demo recording** (GIFs, tapes, drift replays): **`scripts/README_DEMO_RECORDING.md`**.

---

## Open source vs ArchRad Cloud

**This repository is only the deterministic engine** — local, offline, no phone-home.

| Here (OSS) | ArchRad Cloud (commercial product) |
|------------|-------------------------------------|
| IR **structural** + **architecture lint** (`validate`, `IR-STRUCT-*`, `IR-LINT-*`), compiler (`export`), **`validate-drift`** (on-disk vs fresh export), OpenAPI **document-shape** warnings, golden Docker/Makefile | **Policy engine**, deeper **architecture intelligence**, **AI remediation**, richer **drift / sync** UX in the builder |
| `archrad` CLI forever, no account required for this package | Auth, orgs, **quotas**, billing |
| No proprietary **LLM** orchestration or “repair” loops | LLM generation, repair, multi-model routing |
| No Git sync, no enterprise policy injection in this repo | Git push, governance, compliance dashboards |

You can depend on this CLI and library **without** ArchRad Cloud. The cloud product stacks collaboration and AI on top of the same deterministic contract.

---

## Contributing

See **`CONTRIBUTING.md`**.

---

## License

Apache-2.0 — see **`LICENSE`**.
