# Changelog

All notable changes to **`@archrad/deterministic`** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2] - 2026-09-02

### Changed

- Re-recorded the README demo from the 0.7.2 release candidate, showing the zero-setup demo and a cited repository scan.
- Updated package, MCP server, and recording metadata for 0.7.2.
- Refreshed the LLM-facing package summary to lead with repository scanning and the 0.7 first-run workflow.

### Security

- Raised the minimum `js-yaml` and Model Context Protocol SDK versions and refreshed their locked production
  dependencies, eliminating all npm audit findings in the production dependency graph at release time.

### Fixed

- Corrected remaining one-shot examples for this multi-binary package to use `npx --package=@archrad/deterministic archrad ...`.
- No intended engine, CLI, rule, or output contract changes.

## [0.7.1] - 2026-08-30

### Fixed

- **Corrected the quick-start command in the README.** 0.7.0 documented
  `npx @archrad/deterministic demo`, which fails with `could not determine executable to run`.
  `npx <package>` resolves a bin whose name matches the package name; this package ships
  `archrad` and `archrad-mcp`, so with two non-matching bins npx refuses to pick one. The
  quick start is now `npm install -g @archrad/deterministic` followed by `archrad demo`.
  For a one-shot run without installing, use `npx --package=@archrad/deterministic archrad demo`.
- No functional changes. `archrad demo` itself worked correctly in 0.7.0 — only the
  documented invocation was wrong. Since npmjs.com renders the README from the published
  tarball, correcting it requires a release.

## [0.7.0] - 2026-08-28

**Theme:** `archrad scan` — draft-IR generation from a real repository, graded by confidence, cited down to the line.

### Added

- **`archrad demo`** — runs a bundled example end to end with **no arguments, no IR file, and no setup**, from any working directory. Prints the findings, states that the run was deterministic, and points at `scan` / `explain` / `validate` as next steps. Exits `0` so a first run never looks broken.
  - Fixes a first-run failure: the README previously opened with `archrad validate --ir fixtures/demo-direct-db-violation.json`, which only resolves from a git clone. After `npm install -g` there is no `fixtures/` directory in the caller's CWD, so the documented quick start errored with `--ir file not found`. Bundled assets are now resolved relative to the installed package, not the CWD.
  - Covered by `src/cli-demo.integration.test.ts`, which runs the command from an unrelated temp directory so the regression cannot recur silently.
- **`archrad scan [path]`** — points at a repository and emits a **draft IR** (`metadata.status: "draft"`) from six extractors, run in priority order and merged:
  - `compose` (**high** confidence) — `docker-compose.yml` / `compose.yaml`, reusing `dockerComposeToCanonicalIr()`.
  - `kubernetes` (**high**) — Deployment/StatefulSet/DaemonSet/Pod/Job/CronJob/Service/Ingress manifests, detected by content (any `.yaml`/`.yml` with `apiVersion` + a recognized `kind`, not filename). Reuses `inferTypeFromImage()` and the connection-env-var matching from the `compose` path so a Postgres StatefulSet and a Postgres Compose service classify identically. A `Service` is resolved as an alias to the workload(s) it selects, not its own node; an `Ingress` becomes a `gateway` routing to its backends.
  - `openapi` (**medium**) — OpenAPI/Swagger specs found anywhere in the tree, reusing `openApiStringToCanonicalIr()`.
  - `terraform` (**medium**) — `*.tf` files, mapping recognized `resource` types (AWS/GCP/Azure — RDS, Cloud Run, Pub/Sub, ElastiCache, …) to infra nodes via regex + naive brace-matching (HCL isn't YAML/JSON, and a real parser would be a new dependency). Cross-resource references (`aws_db_instance.orders_db.address`) become edges. Lower confidence than `compose`/`kubernetes` on purpose — regex-over-HCL is less reliable than a real parse.
  - `manifest` (**low**) — `package.json` / `requirements.txt`, mapping driver-level client libraries (`pg`, `ioredis`, `firebase-admin`, …) to the infrastructure they imply, via a hand-maintained lookup (no new runtime dependency).
  - `code` (**low**) — shallow regex analysis of source via `reconstructIrFromCodebase()`, run with a new `singleService` option so a monolith's route modules read as one service instead of decomposing.
  - CLI: `--out`, `--extractors <list>`, `--exclude <pattern>`, `--dry-run`, `--verbose`.
- **Provenance on every node and edge** — `config.provenance[]`: `{ inferred_from: "file:line", confidence, extractor }`. Multiple sources agreeing on the same node union their provenance rather than duplicating it.
- **`scanNodeId(kind, name)`** — canonical id construction so independent extractors describing the same infrastructure (a Postgres database, a Redis cache) agree on an id and can be merged.
- **Confidence-aware merge (`mergeDraftFragments`)** — unlike `fragment merge` (which errors on `node.id` conflicts), `scan` treats overlap as the expected signal that two sources agree: the highest-confidence body wins, ties break by extractor priority, and all contributing provenance is unioned.
- **Cross-tier duplicate unification (`unifyDraft`)** — a second merge pass that catches what id-based merging can't: the same app represented as `gateway` (code) vs a generic `service` (manifest), and the same datastore named differently per tier (e.g. `firestore` vs a client-variable-derived name). Resolved by grouping on an explicit `scanRoot` tag (for the one whole-scanned-unit node each of `manifest`/`code` can produce) and on shared `type` for known singleton infra (postgres, mongodb, cache, firestore, …), with a safety check that skips merging if a single extractor already reports more than one instance of that type.
- **`reconstructIrFromCodebase` gained `singleService`** (opt-in, default off — existing decomposition behavior is unchanged for direct callers).

### Changed — architecture lint findings

> **Upgrading from 0.6.x:** the rules below now produce **fewer** findings for the same
> input graph. Every change in this section suppresses a false positive; none of them
> introduce a new finding. A pipeline that passed on 0.6.x cannot begin failing because
> of this release. If you assert on exact finding counts, expect them to drop.

- **Compose `depends_on` edges are no longer treated as runtime calls.** Startup ordering is operational topology, not evidence that one component calls another. Edges carrying `metadata.relation: "depends_on"` are now excluded from `IR-LINT-DIRECT-DB-ACCESS-002`, `IR-LINT-SYNC-CHAIN-001`, and the shared sync-adjacency graph. New predicate `edgeIsDeploymentOrdering()` is exported from `lint-graph.ts`.
- **`IR-LINT-HIGH-FANOUT-004` now counts dependencies, not raw out-degree.** Edges that target an HTTP *endpoint* node are excluded, because OpenAPI ingestion represents a single API surface as gateway→endpoint edges — routes are not downstream dependencies and should not inflate architectural fan-out. `depends_on` edges are excluded too. Effect: gateways fronting more than five documented routes no longer report fan-out. Where several nodes still breach the threshold, their findings may be emitted in a different relative order than in 0.6.x (output remains deterministic for a given input).
- **`IR-LINT-NO-HEALTHCHECK-003` recognizes health routes on non-HTTP nodes.** The rule still only applies to graphs containing at least one HTTP-like node, but the search for a health path now scans every node rather than only HTTP-like ones — a health route modeled as a `service` node now satisfies it. Also satisfied by a non-empty `config.healthSignals` array, which the Kubernetes extractor populates from probe definitions.
- **`IR-LINT-ISOLATED-NODE-005` exempts infrastructure leaf sinks.** An inferred cache, DNS, search, storage, SMTP, or observability node with no edges is a normal outcome of manifest-level scanning, not an architecture defect.
- **`IR-LINT-DEAD-NODE-011` exempts three more legitimately terminal shapes:** reconstructed outbound destinations (`config.external === true` — the repo can show the call to Stripe, never Stripe's internals), one-shot Compose containers (`config.compose.oneShot === true`), and a Kubernetes `Service` node whose only inbound edges are `serviceCall` / `routes` relations.
- **`isInfraLeafSinkLintType()` now includes `observability`**, which feeds both of the exemptions above.

### Changed — reconstruct and scan

- **Auth-middleware detection now requires usage, not just an import.** A bare `import passport from 'passport'` no longer produces an `auth_middleware` artifact; detection requires `passport.authenticate/initialize/session/use(...)`. Fixes false-positive (and duplicate) auth nodes in `archrad reconstruct` and `archrad scan`.
- **`dbNodeType` is now exported** from `reconstruct.ts`, and the `code` extractor's provenance attribution now matches each datastore/external-service node to *its own* detected artifact (by inferred type / call destination) instead of the first one found anywhere in the codebase — fixes misattributed `file:line` citations when a codebase has more than one datastore or outbound call destination.
- **`ScanOptions.scope`** — `'all'` (library default, backwards compatible) or `'production'`, which additionally drops conventional test, example, doc, demo, and story files from the file tree. The CLI defaults to `production` so fixtures and Storybook stories do not become production findings.
- **Two new cross-tier unification passes** in `merge-draft.ts`, both exported:
  - `unifyEquivalentComponentNames()` — merges same-type components whose names differ only by separators or display spacing (Maven `Balance Reader` vs Kubernetes `balancereader`). Refuses the merge when a single extractor contributed more than one node in the group, since that is evidence of genuinely distinct components, and requires at least two extractors to agree.
  - `unifyCorroboratedApps()` — folds extractor-specific views into the single proven scan root. Requires either an exact OpenAPI title/alias match, or two shared infrastructure neighbours corroborated by two independent Compose files. A shared service name alone never triggers a merge.
- **`config.scanAliases`** is tracked internally through unification and, like `config.scanRoot`, stripped before nodes reach the public IR.

### Added (tests)

70 new tests under `src/scan/` (six extractors, canonical ids, confidence-aware merge, cross-tier unification, determinism, byte-stable golden fixtures), 8 new regression tests in `src/reconstruct/reconstruct.test.ts` for the auth-usage and `singleService` changes, and coverage in `src/ir-lint.test.ts` for every lint change listed above. Full suite: **583 passing across 41 files**.

## [0.6.1] - 2026-05-21

**Theme:** Source reconstruction quality — service decomposition, accurate node naming, external service identification.

### Added

- **Service decomposition (Node.js)** — `archrad reconstruct` now emits one node per detected service boundary instead of collapsing everything to a single gateway:
  - Files in `routes/` / `controllers/` / `handlers/` / `endpoints/` directories → one `service` node per file
  - NestJS `*.controller.ts` files and files with `@Get/@Post/…` artifacts → one `service` node per controller
  - Entry files with `app.listen()` → `gateway` node
  - BullMQ `Worker`, Agenda `define`, and cron `schedule` files → `worker` node
  - Monolithic layout (no dedicated route directory) → unchanged single-node output (no forced decomposition)
- **Worker detection** — new `worker_definition` artifact kind for BullMQ, Agenda, and node-cron workers.
- **App entry detection** — new `app_entry` artifact kind for files that call `app.listen()` / `fastify.listen()`.
- **External service identification** — outbound HTTP calls with hardcoded or env-var URLs create distinct external service nodes per destination hostname (e.g., `stripe`, `auth0`, `google`). gRPC `new FooServiceClient(target)` calls similarly produce destination-specific nodes.
- **`destination` field on `DetectedArtifact`** — carries the normalized hostname/service label for `external_http` artifacts.
- **`connectionName` field on `DetectedArtifact`** — carries the env var or variable name for `db_connection` artifacts (used for node naming).

### Changed

- **Node naming** — DB/cache nodes now use the most user-recognizable name available: (1) env var name (`REDIS_URL` → `"redis"`, `SESSION_REDIS_URL` → `"session-redis"`), (2) connection variable name (`const userDb = new Pool(…)` → `"userDb"`), (3) library/driver name as fallback. Node IDs and names no longer include `"env_var"` or other detection-method metadata.
- **DB env var detection priority** — env var patterns are checked before library import patterns so that named env vars take precedence for node naming.
- **CommonJS `require(...)` support** — all `(?:require|from)` patterns now handle `require('pkg')` (parenthesized CommonJS) in addition to ES module `from 'pkg'` syntax. Fixes BullMQ, Redis, and other CommonJS-only imports being missed.
- **Shared DB node naming** — if a later service encounter provides a `connectionName` for an already-registered DB node type, the node name is upgraded to the user-recognizable name.
- **Generic external node deduplication** — services without a detectable destination URL share a single `"external-service"` fallback node instead of creating one per service group.
- **BullMQ implicit Redis** — added `(?:require|from)\s*\(?\s*['"`]bullmq['"`]` to DB patterns as a proxy for a Redis cache dependency.
- **Firebase/Firestore detection** — added `firebase-admin` import pattern → `firestore` DB node type.
- **`isDbLikeType`** update not required — `firestore` matching via existing `db` substring (`is**Db**Like`) does not fire; treated as a distinct type in `dbNodeType`.
- **Reconstructed IR lint behavior** — after decomposition, `IR-LINT-DIRECT-DB-ACCESS-002` fires only when the `gateway` entry node has a direct edge to a datastore with no intermediate service layer. Decomposed service nodes are type `service` (not HTTP-like), so their DB edges do not trigger the rule. Validated against the InkByte server monorepo (525+ files) — no false-positive DIRECT-DB-ACCESS findings.

### Added (tests)

Five new integration tests in `src/reconstruct/reconstruct.test.ts`:
1. `Express multi-route decomposition` — three route files → gateway + 3 service nodes with gateway edges
2. `NestJS controller decomposition` — three `*.controller.ts` files → gateway + 3 service nodes
3. `HTTP routes + BullMQ worker` — route file + worker file → gateway + service + worker nodes
4. `External service identification` — axios/fetch to Stripe and reCAPTCHA → distinct named external nodes
5. `Monolithic app (negative)` — all routes in one file → single `gateway` node (no forced split)

### Documentation

- README `### Source reconstruction` sections rewritten to document service decomposition logic, node naming rules, external service detection, and guidance for interpreting lint findings on reconstructed IR.

## [0.6.0] - 2026-05-18

**Theme:** Implementation governance — source-code → IR reconstruction and IR-DRIFT-IMPL-* drift rules.

### Added

- **`archrad reconstruct`** — new CLI command that walks a real codebase and emits a canonical IR graph. Detects HTTP entry points, database connections, auth middleware, service-to-service calls, and healthcheck routes. Flags: `--from <path>` (required), `--output <path>` (default: `reconstructed-ir.json`), `--language <auto|nodejs|python|csharp>`, `--exclude <pattern>` (repeatable), `--dry-run`, `--verbose`.
- **`archrad validate --codebase <path>`** — extends the existing validate pipeline with implementation drift analysis. When `--codebase` is provided: (1) runs standard IR-STRUCT-* and IR-LINT-* validation on the authored IR; (2) reconstructs IR from the codebase; (3) compares authored vs reconstructed and emits IR-DRIFT-IMPL-* findings. Additional flags: `--codebase-language <auto|nodejs|python|csharp>`, `--codebase-exclude <pattern>` (repeatable), `--impl-drift-fail-on <error|warning|never>` (default: `error`). **`--fail-on` / `--fail-on-warning` / `--max-warnings` apply only to IR-STRUCT-* and IR-LINT-* (plus merged PolicyPacks); IR-DRIFT-IMPL-* exit behavior is controlled solely by `--impl-drift-fail-on`.**
- **IR-DRIFT-IMPL-* finding category** — seven rules for implementation drift:
  - **`IR-DRIFT-IMPL-000`** (warning) — Authored IR could not be parsed for drift comparison (fix structural/graph shape first).
  - **`IR-DRIFT-IMPL-001`** (warning) — HTTP-like nodes in the authored IR; reconstruction detected **zero** artifacts in the codebase scan (possible wrong `--codebase` root or undetected framework).
  - **`IR-DRIFT-IMPL-002`** (warning) — HTTP or health routes detected in code but authored IR defines **no** HTTP-like node types.
  - **`IR-DRIFT-IMPL-003`** (error) — **Critical.** Direct database connection in code not present as an edge in the authored IR. Catches the "dummy IR" attack pattern.
  - **`IR-DRIFT-IMPL-004`** (error) — HTTP entry point in code not present in authored IR.
  - **`IR-DRIFT-IMPL-005`** (warning) — Service-to-service call in code not present as an edge in authored IR.
  - **`IR-DRIFT-IMPL-006`** (info) — Auth middleware present in code but no auth node in authored IR.
- **Language analyzers** (`src/reconstruct/`) — file-scanning analyzers for Node.js/TypeScript (Express, Fastify, NestJS, Passport, pg, Prisma, TypeORM, Sequelize, Mongoose, Redis, axios, gRPC), Python (Flask, FastAPI, Django, DRF, SQLAlchemy, psycopg2, PyMongo, redis-py), and C# (ASP.NET Core minimal API, controller attributes, EF Core, Dapper, StackExchange.Redis, Auth0, Okta, Keycloak). No subprocess spawning — all analysis is done via file scanning.
- **`archrad explain IR-DRIFT-IMPL-{000..006}`** — canonical guidance for each new rule code.
- **`IrFindingLayer`** extended to include `'impl-drift'`; `RuleLayer` in `explain.ts` includes `'impl-drift'`; `layerForCode()` routes `IR-DRIFT-IMPL-*` → `'impl-drift'`.
- **New public API exports:** `reconstructIrFromCodebase`, `compareImplementationDrift`, and types `ReconstructOptions`, `ReconstructResult`, `DetectedArtifact`, `ArtifactKind`, `Language`.
- **`archrad.yml` codebase keys** — `codebase`, `codebaseLanguage`, `codebaseExclude`, and `implDriftFailOn` default `validate --codebase` and `reconstruct` flags.

### Changed

- **`IR-DRIFT-IMPL-002` / `004`** — deduplicated findings when HTTP routes in code have no matching HTTP nodes in the authored IR (`004` error covers that case; `002` remains for health-only gaps).
- **`IR-DRIFT-IMPL-005`** — outbound service dependencies must be documented via `metadata.relation` / `protocol` or remote-style target types; internal gateway→service layering alone no longer suppresses the rule.
- **Reconstruction quality** — artifact `line` numbers, corrected DB classifications (SQL Server, Cassandra), and health URL taken from the first detected health route path.

### Fixed

- **Dependabot / `npm audit`** — bumped transitive `hono`, `fast-uri`, `ip-address`, and `postcss` in `package-lock.json`.
- **`uuid`** — Express export template and golden fixtures use `^11.1.1` (GHSA buffer-bounds advisory).
- **CodeQL** — policy-pack manifest parsing avoids polynomial backtracking; `generate-corpus.mjs` uses `crypto.randomInt` instead of `Math.random`.

### Scope limits (documented)

Reconstruction is **best-effort signal, not certainty**:
1. Dynamic patterns (eval, reflection, metaprogramming) are not detected.
2. Runtime configuration determining service topology cannot be statically analyzed.
3. Cross-language services in the same codebase reduce accuracy.
4. Heavy framework abstractions may obscure routes or connections.

IR-DRIFT-IMPL-* findings should be treated as "review required", not absolute truth.

## [Unreleased]

### Added

- **`archrad.yml` / `archrad.yaml` project config** — walks up from CWD and feeds matching values as **defaults** to `validate`, `lint`, `export`, `validate-drift`, and `init`. Explicit CLI flags always win. New global flags **`--config <path>`** and **`--no-config`**. Supported keys: **`ir`**, **`target`**, **`output`**, **`policies`**, **`policiesRequireSigned`**, **`cosignPubkey`**, **`failOn`**, **`failOnWarning`**, **`maxWarnings`**, **`skipLint`**, **`skipIrLint`**, **`hostPort`**, **`skipHostPortCheck`**, **`strictHostPort`**, **`strictExtra`**, **`report`**, **`findingsJsonOut`**, **`metricsFile`**. File-path values resolve relative to the config directory; unknown keys are rejected loudly. Library: **`src/config.ts`**, **`src/cli-config.ts`**. Docs: **`docs/CONFIG.md`**.
- **`archrad lint`** — architecture-lint-only runner (**`IR-LINT-*`** + PolicyPacks). Skips IR structural pre-checks for a fast inner loop, but still surfaces blockers for unparseable IR (never a silent pass). Same flags and exit policy as `archrad validate` plus **`--rule <code>`** (repeatable; case-insensitive) for focusing on a single rule. Reads defaults from **`archrad.yml`**.
- **`archrad explain <code>`** — canonical rule guidance lookup (**`IR-STRUCT-*`**, **`IR-LINT-*`**, **`DRIFT-*`**). Case-insensitive; unknown codes print a "did you mean" hint via edit-distance + shared-prefix scoring. Flags: **`--json`** (machine-readable `{ code, title, remediation, docsUrl, layer }`), **`--list`** (every registered code grouped by layer). Library: **`src/explain.ts`**, **`listAllExplanations`**, **`explainRuleCode`**, **`suggestRuleCodes`**.
- **Signed PolicyPacks** — `archrad validate`, `archrad lint`, `archrad export`, and `archrad validate-drift` now accept **`--policies-require-signed`** and **`--cosign-pubkey <path>`**. When enforced, every file in `--policies` must appear in a sha256 manifest (`archrad-policy-pack.sha256`) that hash-matches on disk; with `--cosign-pubkey`, the manifest's detached `.sig` is also verified via `cosign verify-blob` before loading. Unsigned directories continue to load by default with `signedBy: 'unsigned'` so the upgrade is fully backward-compatible. New library exports: `buildPolicyPackManifest`, `parsePolicyPackManifest`, `verifyPolicyPackManifest`, `verifyCosignSignature`, `discoverPolicyPackManifest`, `sha256Hex`, `POLICY_PACK_MANIFEST_NAME`, `POLICY_PACK_SIGNATURE_NAME`, plus `PolicyPackSigningOptions` / `PolicyPackManifestInput` on the existing loaders.
- **`archrad policies-sha256 --dir <dir>`** — deterministic manifest generator so users can produce signed PolicyPacks in one CLI call (pair with `cosign sign-blob` for `--cosign-pubkey` verification).

### Changed

- **`archrad --version`** now reads the version from the shipped `package.json` (was hardcoded to `0.3.0` and drifted from the published tag).
- `LoadPolicyPacksResult.ok` now includes a `signedBy` field (`'unsigned' | 'sha256-verified' | 'cosign-verified'`) so library callers can surface signing provenance in Cloud and CI summaries.

## [0.5.0] - 2026-05-13

**Theme:** Docker Compose interpolation, Traefik ingress edges, monolith lint profile.

### Added

- **Compose `${VAR}` expansion** — `parseDotEnvText`, `composeInterpolationBindings`, `expandComposeVars` (`$$`, `${VAR}`, `${VAR:-def}`, `${VAR-def}`); `dockerComposeToCanonicalIr` accepts `interpolateFrom` and `interpolateFromProcessEnv`; expansion applies to service `environment`, `labels`, and `depends_on`. **`archrad init`:** `--compose-env-file` (repeatable), `--compose-merge-process-env`.
- **Traefik → IR edges** — Infers gateway/backend links from `traefik.http.services.*.loadbalancer.*` and `traefik.http.routers.*.service` labels; edge metadata `relation: traefikIngress`, `traefikBackend`. Exports `enumerateTraefikHttpBackendRefs`, `DockerComposeInitOptions`.
- **`monolith-relaxed` lint profile** — Suppresses `IR-LINT-DIRECT-DB-ACCESS-002`, `IR-LINT-MISSING-AUTH-010`, `IR-LINT-MULTIPLE-HTTP-ENTRIES-009` for Rails/Django-style graphs. **`--ir-lint-profile`** on `validate`, `lint`, `export`, `validate-drift`; **`archrad.yml`** key **`irLintProfile`**; `runDeterministicExport` / drift pass `lintProfile` through `validateIrLint`.

### Fixed

- **`expandComposeVars`** — Left-to-right pass replaces global `$$`/regex ordering bugs so Compose-style `$${VAR}` yields a literal `$` plus expanded `${VAR}`. After consuming `$$`, the cursor sits on `{`; the importer now parses `${…}` in that position instead of emitting raw `{…}`.

## [0.4.2] - 2026-05-07

**Theme:** Docker Compose `init` — one edge per service pair (no spurious duplicate-edge lint).

### Fixed

- **`archrad init --from` (Docker Compose):** When a service both **`depends_on`** another service and declares a connection URL (e.g. **`DATABASE_URL`**) to that same service, the importer now emits **one** edge per **`(from, to)`** — connection env is processed first, then **`depends_on`** skips an already-linked pair. Avoids **`IR-LINT-DUPLICATE-EDGE-006`** on typical Compose files.

### Added

- **Fixture** — `fixtures/docker-compose/demo-layered-two-bc.yml` for layered two–bounded-context smoke + lint tests.

## [0.4.1] - 2026-04-29

**Theme:** MCP Registry — npm ownership marker + publisher manifest.

### Added

- **`mcpName`** in **`package.json`** (`io.github.archradhq/deterministic`) for [MCP Registry](https://modelcontextprotocol.io/) npm package verification.
- **`server.json`** — manifest for the official **`mcp-publisher`** CLI (stdio transport, **`@archrad/deterministic`** on npm).

### Changed

- **`archrad-mcp`** reports **`serverInfo.version`** from the shipped **`package.json`** (was a stale hardcoded literal).

## [0.4.0] - 2026-04-19

**Theme:** CI — GitHub Action, validate UX, SOC2 evidence hook.

### Added

- **`archrad validate`:** **`--fail-on error|warning|never`** (GitHub Actions style; **`never`** always exits **0**); **`--report <path>`** (self-contained HTML); **`--metrics-file <path>`** (JSON counts for CI); **`--findings-json-out <path>`** (findings array for integrations). Library: **`findingMetrics`**, **`validationExitPolicyFromFailOn`**, **`writeFindingsHtmlReport`** (`src/validate-report-html.ts`).
- **`packages/archrad-action`** — GitHub Action: OSS mode; **enterprise** inputs **`soc2-org-id`**, **`soc2-api-key`**, optional **`export-dir`** + **`target`** (drift), **`api-base-url`** → POST evidence to **`/api/soc2/:orgId/evidence/github-action`** (ArchRad server). Tag **`v1`** tracks the first stable action release line in this monorepo.
- **ArchRad server (InkByte product):** **`POST /api/soc2/:organizationId/evidence/github-action`** (Bearer org integration key vs **`settings.integrations.githubAction.apiKeySha256`**); evidence type **`github_action_governance`**; org schema **`settings.integrations.githubAction`**.

## [0.3.0] - 2026-04-16

**Theme:** Generate — IR from Docker Compose without hand-authored JSON.

### Added

- **`archrad init`** — **`--from <docker-compose.yml|yaml|compose.yml>`**: map **services** → nodes (image-based type inference; published **ports** promote unknown images to **`gateway`** for HTTP-facing lint), **`depends_on`** → edges, **`DATABASE_URL`** / **`REDIS_URL`** / **`AMQP_URL`** / **`MONGODB_URI`** / … → edges when the URL hostname matches another service. **`--output`** (default **`archrad-graph.json`**), **`--dry-run`**, **`--verbose`**. **`src/init/docker-compose.ts`**.
- **Fixture** — `fixtures/docker-compose/demo-direct-db.yml` for smoke tests.
- **Docs:** **`docs/CLI_REFERENCE.md`** (all `archrad` commands and flags); **`docs/EXPORT.md`** (deterministic export + public positioning). **`INGEST.md`**, **`DRIFT.md`**, **`README.md`** cross-linked and aligned with CLI (**`--json`**, **`--skip-lint`**, **`--report-json`**, **`init -f`**, OpenAPI **`--out`**).
- **`archrad yaml-to-ir`:** **`--yaml`** accepts an **https** URL (e.g. GitHub raw YAML); optional **`-H`** for authenticated fetches. Uses **`readTextFromPathOrUrl`** in **`src/ingest/openapi.ts`**.
- **`scripts/github-validate-samples.mjs`** — public Git **tree** API (optional **`GITHUB_TOKEN`** / **`GH_TOKEN`** for rate limits): **`--repo owner/name`**, **`--ref`**, **`--prefix`**, **`--max`**, **`--scan-limit`**, **`--quiet` / `-q`**; **`--random-repo`** / **`--list-sample-repos`**; env **`ARCHRAD_VALIDATE_REPO`** when **`--repo`** is omitted. Classifies OpenAPI vs blueprint YAML, then **`yaml-to-ir`** / **`ingest openapi`** + **`validate`**.
- **`archrad export`:** **`--policies <dir>`** wired in the CLI (PolicyPack merge with **`--skip-ir-lint`** semantics unchanged).

### Fixed

- **`scripts/github-validate-samples.mjs`** — **`--prefix`** no longer consumes the next flag when the prefix value is empty (e.g. PowerShell); tree fetch retries with the repo **default branch** when **`ref`** returns **404**.

## [0.2.0] - 2026-04-14

**Theme:** Ingest — turn existing enterprise artifacts into validated IR.

### Added

- **`archrad ingest backstage`** — **`--catalog <dir>`**: recursively scan for `catalog-info.yaml` / `catalog.yaml`; map **Component**, **Resource**, **API**, **System** to IR nodes; follow **Location** `spec.targets` / `spec.target` file pointers (http(s) URLs skipped with a report entry). Edges from **`spec.dependsOn`** and **`spec.system`**. Default excludes: `node_modules`, `dist`, `.git`, `build`, `coverage`, `.next`, `target`. Summary on stderr; optional **`--report-json`**; CI-safe exit **0** / **1**. Live Catalog API (**`--url` / `--token`**) deferred. `src/ingest/backstage.ts`.
- **`archrad fragment merge`** — Merge **two or more** IR JSON files. Default **union-by-`node.id`**: duplicate id + identical body deduplicated; duplicate id + any body difference → **`FragmentMergeConflictError`**, full report to stderr, no output file, exit **1**. Unknown edge endpoints → **WARN** and skip. **`--prefix-fragments`** restores disjoint union with per-fragment id prefixes and **`provenance.mode: 'prefix'`**. `src/fragment/merge.ts`.
- **`archrad ingest openapi`** — **`--spec`** accepts **http(s) URL** or local path (`src/ingest/openapi.ts`). Repeatable **`-H` / `--header`** for URL fetches only (e.g. `Authorization: Bearer …`); ignored for local paths. Default **Accept** and **User-Agent** on HTTP requests.
- **`docs/INGEST.md`** — ingest + merge workflow; YAML-only Backstage; aligned command names; no IR “v1.1” claim.
- **`docs/OSS_DOCUMENTATION_VERSIONING.md`** — tier-1 OSS docs versioned per release; **`RELEASING.md`** checklist updated.
- **Fixtures** — `fixtures/backstage/demo/`, `fixtures/backstage/location/` for Backstage smoke tests.
- **Tests** — `src/fragment/merge.test.ts`, `src/ingest.integration.test.ts` (spawn `dist/cli.js`).

### Fixed

- **`ir-lint-missing-auth-010.corpus.test.ts`** — corpus path corrected to `archlora/corpus/corpus-auth-010-pairs.json`.

## [0.1.6] - 2026-04-10

### Added

- **`docs/CI.md`** — exit code semantics (`--fail-on-warning`, `--max-warnings`) and copy-paste snippets for GitHub Actions, GitLab CI, Bitbucket Pipelines, Jenkins, and Azure DevOps.
- **`scripts/generate-corpus.mjs`** — validates hand-written `corpus/*.json` pairs; `--count` mode generates weighted synthetic JSONL training pairs via the deterministic engine. Run `npm run build` first.
- **Integration tests** — `archrad validate` exit code assertions (`src/cli-exit.integration.test.ts`).

### Changed

- **MCP** — Rewrote all six `registerTool` title/description blocks for agent discoverability (`src/mcp-server-tools-patch.ts`).
- **npm package** — `corpus/` excluded from published tarball (`.npmignore` + removed from `package.json` `files`).

### Fixed

- **`archrad_validate_drift`** MCP schema: `target` enum is `python` | `nodejs` only, aligned with `docs/MCP.md`.

### Security

- `npm audit fix` applied to dev/test transitive dependencies.

## [0.1.5] - 2026-04-07

### Added

- **`archrad-mcp`** — [Model Context Protocol](https://modelcontextprotocol.io/) server over **stdio** (same deterministic engine as the CLI). Tools: **`archrad_validate_ir`**, **`archrad_lint_summary`**, **`archrad_validate_drift`**, **`archrad_policy_packs_load`**, **`archrad_suggest_fix`** (static remediation per built-in code — **not** generated patches), **`archrad_list_rule_codes`**. IR input: inline **`ir`** or **`irPath`** (JSON file; max **25 MiB**). **`archrad_suggest_fix`** **`docsUrl`** → GitHub **`docs/RULE_CODES.md`**. Scope: **`docs/MCP.md`** (OSS: IR + local paths; no tracking params in tool responses).
- **Docs:** **`docs/DRIFT.md`** (deterministic drift semantics), **`docs/RULE_CODES.md`** (built-in codes + anchors for MCP **`docsUrl`**), **`docs/MCP.md`** (local testing).

### Fixed

- **CodeQL** `js/polynomial-redos` — linear-time hyphen/underscore edge stripping for **`safeId`** / OpenAPI-derived ids (replaces ambiguous alternation regexes).

## [0.1.4] - 2026-04-06

### Added

- **`loadPolicyPacksFromFiles(sources)`** — compile PolicyPack YAML/JSON from in-memory **`{ name, content }[]`** (same semantics as **`loadPolicyPacksFromDirectory`**; no filesystem).
- **Declarative policy packs** — YAML/JSON documents (`apiVersion: archrad/v1`, `kind: PolicyPack`) with `rules` that match **nodes** or **edges** on the parsed lint graph. Loader: **`loadPolicyPacksFromDirectory(dir)`** (supports `*.yaml`, `*.yml`, `*.json`; duplicate `rule.id` across the directory is rejected).
- **CLI** — **`archrad validate`**, **`archrad export`**, and **`archrad validate-drift`** accept **`--policies <dir>`** to merge compiled rules after built-in **`IR-LINT-*`** (skipped when **`--skip-lint`** / **`--skip-ir-lint`** is set).
- **ArchRad Cloud (InkByte server)** — org **`settings.archPolicyPacks`** (array of **`{ name, content }`**) is merged into deterministic export when **`organizationId`** is on the export request; **`POST /api/drift-check`** accepts **`organizationId`**, **`policyPackFiles`**, and **`skipArchPolicyPacks`** (membership required when **`organizationId`** is set).
- **Library** — **`validateIrLint(ir, { policyRuleVisitors })`**; **`runDeterministicExport`** / drift helpers accept **`policyRuleVisitors`** the same way.
- **Normalization** — **`NormalizedNode`** now includes **`metadata`** (from each node’s `metadata` object) so **`buildParsedLintGraph`** / policy **`match.node.tags`** see **`metadata.tags`** on the graph.
- **`--policies`** applies to all three lint commands consistently — 
  `validate-drift` uses the same policy layer when building the 
  reference export, so org rules are enforced end-to-end across 
  validate → export → drift.

## [0.1.3] - 2026-04-04

### Fixed

- **CLI** (`validate`, `export`, `validate-drift`): a missing **`--ir`** file now reports **`archrad: --ir file not found: <path>`** instead of **`invalid JSON`**.

### Changed

- **`IR-LINT-MISSING-AUTH-010`** — HTTP entry detection uses **`ParsedLintGraph.inDegree`** (same counts as `buildParsedLintGraph`) instead of a separate scan; reverse adjacency for auth-as-gateway only includes edges whose endpoints exist in **`nodeById`**.
- **Docs:** README documents **OpenAPI security → IR → `IR-LINT-MISSING-AUTH-010`** for the spec-to-compliance workflow.
- **`graphPredicates.ts`:** clarified comments for **`isHttpEndpointType`** vs **`isHttpLikeType`** (`graphql` vs `gateway` / `bff` / `grpc`).

### Added

- **Tests:** structural **`IR-STRUCT-HTTP_*`** coverage for **`graphql`** (validated) vs **`gateway`** (excluded); regression tests locking lint message substrings for **`IR-LINT-DEAD-NODE-011`**, **`IR-LINT-DIRECT-DB-ACCESS-002`**, **`IR-LINT-SYNC-CHAIN-001`** (terminal copy / Show HN).
- **Fixture** **`fixtures/e2e-no-security-openapi.yaml`** (OpenAPI with **no** `security` / `securitySchemes`) + test asserting **`openApiStringToCanonicalIr` → `validateIrLint` → `IR-LINT-MISSING-AUTH-010`** — same pipeline as **`archrad ingest openapi`** + **`archrad validate`**.

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

[Unreleased]: https://github.com/archradhq/arch-deterministic/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/archradhq/arch-deterministic/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/archradhq/arch-deterministic/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/archradhq/arch-deterministic/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/archradhq/arch-deterministic/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/archradhq/arch-deterministic/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/archradhq/arch-deterministic/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/archradhq/arch-deterministic/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/archradhq/arch-deterministic/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/archradhq/arch-deterministic/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/archradhq/arch-deterministic/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/archradhq/arch-deterministic/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/archradhq/arch-deterministic/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/archradhq/arch-deterministic/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/archradhq/arch-deterministic/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/archradhq/arch-deterministic/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/archradhq/arch-deterministic/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/archradhq/arch-deterministic/releases/tag/v0.1.0
