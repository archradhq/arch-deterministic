# Built-in finding codes (IR-STRUCT, IR-LINT, DRIFT)

**Canonical OSS reference** — ships in **`@archrad/deterministic`**.  
**MCP** **`archrad_suggest_fix`** returns **`title`**, **`remediation`**, and a **`docsUrl`** pointing at the matching section below. **PolicyPack / org** rules use custom ids (e.g. `ORG-*`) — not listed here.

**Product / marketing** copy may live on **archrad.com**; **deterministic semantics** are defined in this repo.

---

## DRIFT-EXTRA

Extra file not in deterministic export. **Remediation:** Remove stray files from the export directory or add them to the model if they should be generated. Use **`--strict-extra`** semantics as documented for your CI gate.

---

## DRIFT-MISSING

Exported file missing on disk. **Remediation:** Regenerate the export (**`archrad export`**) or restore the missing file so the tree matches the deterministic output for this IR.

---

## DRIFT-MODIFIED

File differs from deterministic export. **Remediation:** Revert manual edits to generated files or update the IR and re-export so the on-disk tree matches the compiler output.

---

## DRIFT-NO-EXPORT

No export produced for drift comparison. **Remediation:** Fix IR structural/lint errors blocking export, or verify **`--target`** and IR content so the exporter emits files.

---

## IR-LINT-DATASTORE-NO-INCOMING-008

Datastore has no incoming edges. **Remediation:** Connect a service or data path to this datastore, or remove it if unused.

---

## IR-LINT-DEAD-NODE-011

Non-sink node with incoming edges but no outgoing edges. **Remediation:** Add an outgoing edge to a downstream consumer, or remove the node if it is obsolete.

---

## IR-LINT-DIRECT-DB-ACCESS-002

HTTP-like node connects directly to a datastore. **Remediation:** Introduce a service or domain layer between HTTP handlers and persistence.

---

## IR-LINT-DUPLICATE-EDGE-006

Duplicate from→to edge. **Remediation:** Collapse duplicate edges or distinguish them with metadata if your model allows.

---

## IR-LINT-HIGH-FANOUT-004

High outgoing dependency count. **Remediation:** Reduce fan-out: split responsibilities, add a facade, batch calls, or use async handoff.

---

## IR-LINT-HTTP-MISSING-NAME-007

HTTP-like node missing display name. **Remediation:** Set a short human-readable **`name`** on the node.

---

## IR-LINT-ISOLATED-NODE-005

Node has no incident edges. **Remediation:** Remove the orphan or connect it with edges.

---

## IR-LINT-MISSING-AUTH-010

HTTP entry missing auth coverage. **Remediation:** Add an auth boundary (auth/middleware/oauth/jwt node or **`config.authRequired: false`** for public endpoints).

---

## IR-LINT-MULTIPLE-HTTP-ENTRIES-009

Multiple HTTP entry nodes without incoming edges. **Remediation:** Prefer a single API gateway or BFF unless multiple public surfaces are intentional.

---

## IR-LINT-NO-HEALTHCHECK-003

No typical health/readiness route on HTTP nodes. **Remediation:** Add a GET route such as **`/health`** or **`/ready`**.

---

## IR-LINT-SYNC-CHAIN-001

Long synchronous chain from HTTP entry. **Remediation:** Shorten the graph or mark non-blocking hops as async in edge metadata.

---

## IR-STRUCT-CYCLE

Directed cycle in the graph. **Remediation:** Remove or break cyclic edges unless your tooling explicitly allows execution loops.

---

## IR-STRUCT-DUP_NODE_ID

Duplicate node id. **Remediation:** Ensure node ids are unique.

---

## IR-STRUCT-EDGE_AMBIGUOUS_FROM

Edge references duplicate source id. **Remediation:** Resolve duplicate node ids first.

---

## IR-STRUCT-EDGE_AMBIGUOUS_TO

Edge references duplicate target id. **Remediation:** Resolve duplicate node ids first.

---

## IR-STRUCT-EDGE_INVALID

Edge is not an object. **Remediation:** Each edge must be an object with **`from`**/**`to`** (or **`source`**/**`target`**).

---

## IR-STRUCT-EDGE_NO_ENDPOINTS

Edge missing endpoints. **Remediation:** Set **`from`** and **`to`** to existing node ids.

---

## IR-STRUCT-EDGE_UNKNOWN_FROM

Edge references unknown source node. **Remediation:** Add a node with the referenced id or correct **`from`**.

---

## IR-STRUCT-EDGE_UNKNOWN_TO

Edge references unknown target node. **Remediation:** Add a node with the referenced id or correct **`to`**.

---

## IR-STRUCT-EDGES_NOT_ARRAY

**`edges`** is present but not an array. **Remediation:** Set **`edges`** to an array of edge objects (or omit **`edges`**).

---

## IR-STRUCT-EMPTY_GRAPH

Graph has no nodes. **Remediation:** Add at least one node before validation or export.

---

## IR-STRUCT-HTTP_METHOD

HTTP method not supported. **Remediation:** Use GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS.

---

## IR-STRUCT-HTTP_PATH

HTTP endpoint path invalid. **Remediation:** Set **`config.url`** or **`config.route`** to a path starting with **`/`**.

---

## IR-STRUCT-INVALID_ROOT

IR root is not a JSON object. **Remediation:** Pass a single JSON object with **`graph`** or top-level **`nodes`**.

---

## IR-STRUCT-NO_GRAPH

Missing graph shape. **Remediation:** Include **`.graph`** with **`nodes`** or a top-level **`nodes`** array.

---

## IR-STRUCT-NODE_INVALID

Node entry is not an object. **Remediation:** Each **`nodes`** entry must be a JSON object with **`id`** and type information.

---

## IR-STRUCT-NODE_INVALID_CONFIG

Node **`config`** is not a plain object. **Remediation:** Use a plain object for **`config`**.

---

## IR-STRUCT-NODE_NO_ID

Node missing non-empty id. **Remediation:** Assign a stable string **`id`** to every node.

---

## IR-STRUCT-NODES_NOT_ARRAY

**`nodes`** is not an array. **Remediation:** Set **`nodes`** to an array of node objects.

---

*Full strings in MCP/CLI mirror **`src/static-rule-guidance.ts`** (single implementation).*
