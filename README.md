# @archrad/deterministic

**Apache-2.0** — the **pure deterministic** layer of ArchRad: turn a blueprint **IR** (JSON graph) into a **FastAPI** or **Express** project with **OpenAPI**, **Docker**, and a **Makefile** — **no LLM**, **no account**, **offline**.

> Unlike a thin wrapper around an API, this package is the **engine**: templates + graph → files, then a **structural** check on the generated `openapi.yaml` so you see problems **before** you build a container.

---

## How it works (architecture)

```
IR (nodes/edges)  →  pythonFastAPI | nodeExpress generators
                           ↓
              openapi.yaml + app code + package metadata
                           ↓
              golden layer (Dockerfile, docker-compose.yml, Makefile, README; host→container e.g. 8080:8080)
                           ↓
              validateOpenApiInBundleStructural(openapi.yaml)  →  warnings (no silent broken spec)
                           ↓
              { files, openApiStructuralWarnings }
```

1. **Generators** map your graph to real paths and contents (`openapi.yaml`, handlers, deps).
2. **Golden path** makes the bundle runnable locally with one obvious command (`make run` → `docker compose up --build`).
3. **Structural validation** parses the generated **OpenAPI** and runs structural rules. Invalid specs surface as **warnings** on export — not after a failed deploy.

**Trust builder:** ArchRad does not blindly dump files. The engine runs a **structural validation pass** on the generated `openapi.yaml`. If the spec is structurally wrong, you get **warnings at export time** instead of discovering a broken contract only after `docker compose up`.

---

## Ways to use it

| Mode | Best for | Example |
|------|-----------|---------|
| **CLI** | Quick local scaffolding, CI, “no Node project” usage | `archrad export --ir graph.json --target python --out ./out` |
| **Library** (`@archrad/deterministic`) | Internal developer portals (IDPs), custom Node build pipelines, your own UI on top of the same engine | `runDeterministicExport(ir, 'python', {})` → file map |

### CLI

**Input is structured IR (JSON), not natural language.** There is no `archrad export --prompt "..."`. You pass a **graph file** (nodes/edges) like `fixtures/minimal-graph.json`. To go from **plain English → IR**, use **ArchRad Cloud** or your own LLM step; this package only does **IR → files**.

After `npm run build` (or `npm install`, which runs `prepare`):

```bash
node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./my-api
# After global install / npx:
archrad export --ir ./graph.json --target node --out ./my-express-api
```

- **`--ir`** — JSON: `{ "graph": { "nodes", "edges", "metadata" } }` or a raw graph (CLI wraps it).
- **`--target`** — `python` \| `node` \| `nodejs`
- **`--out`** — output directory (created if needed)
- **`--host-port <n>`** — host port Docker publishes (default **8080**; container still listens on **8080** inside). Same as env **`ARCHRAD_HOST_PORT`**.
- **`--skip-host-port-check`** — don’t probe `127.0.0.1` before export.
- **`--strict-host-port`** — **exit with error** if the host port appears **in use** (CI-friendly).

By default, if **8080** (or your `--host-port`) looks **busy** on localhost, the CLI **warns** so you can change the port before `docker compose` fails with a bind error.

### Validate the package as a developer

1. `cd packages/deterministic && npm ci && npm run build && npm test`
2. `node dist/cli.js export --ir fixtures/minimal-graph.json --target python --out ./tmp-out`
3. `cd tmp-out && make run` then `curl` the URL shown in the generated **README** (port matches `--host-port` if you set it).
4. Optional: `node dist/cli.js export ... --host-port 18080` if **8080** is already taken.

### Library

```typescript
import { runDeterministicExport } from '@archrad/deterministic';

const { files, openApiStructuralWarnings } = await runDeterministicExport(ir, 'python', {
  hostPort: 8080, // optional; docker-compose publishes hostPort:8080
});
// Integrate `files` into your zip/IDP pipeline; log or surface warnings in your UI.
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
| IR → files, structural OpenAPI warnings, Docker/Makefile golden path | Hosted app, teams, projects |
| `archrad` CLI forever, no account required for this package | Auth, orgs, **quotas**, billing |
| No proprietary **LLM** orchestration or “repair” loops | LLM generation, repair, multi-model routing |
| No Git sync, no enterprise policy injection in this repo | Git push, governance, compliance dashboards |

You can depend on this CLI and library **without** ArchRad Cloud. The cloud product stacks collaboration and AI on top of the same deterministic contract.

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
