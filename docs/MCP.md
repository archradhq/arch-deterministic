# ArchRad MCP server — specification

**Status:** **0.1.x** — `archrad-mcp` ships in **`@archrad/deterministic`** (stdio MCP, same engine as CLI).  
**Audience:** Engineering + launch narrative (Show HN / registry listing).

## 1. Problem statement

| Mode | Behavior |
|------|------------|
| **Reactive** | CI runs `archrad` after code exists → catches drift late. |
| **Proactive** | An MCP server answers **before** edits land: “Is this edge allowed?”, “What does IR-LINT say about this sketch?” |

Agents optimize for *working code*; ArchRad supplies **deterministic constraints** so the loop can ask the engine *before* violating architecture.

## 2. OSS vs product boundary

Aligned with **`STRUCTURAL_VS_SEMANTIC_VALIDATION.md`** (this folder) and your org’s OSS/product split docs.

| Surface | Ships in **OSS** (`@archrad/deterministic`, binary **`archrad-mcp`**) | Stays in **product / Cloud** |
|---------|------------------------------------------------------------------------|------------------------------|
| IR structural validation (`IR-STRUCT-*`) | Yes | — |
| Architecture lint (`IR-LINT-*`) + PolicyPack YAML from **local dir** | Yes | — |
| `validate_drift` vs on-disk export (local paths) | Yes | — |
| Static remediation text per **built-in** code (`archrad_suggest_fix`) | Yes | — |
| Org **`settings.archPolicyPacks`**, Firestore, membership | — | Yes |
| Semantic “is this business-correct?” reasoning | — | Yes (future assisted tools) |

**Rule of thumb:** If the tool only needs **IR JSON + local files**, it can live in the public MCP server. If it needs **tenant identity, billing, or org policy from Cloud**, expose a **separate** “ArchRad Cloud” MCP connector (private or authenticated) — do not move Cloud policy enforcement into OSS without an explicit product decision.

## 3. Transport and packaging

- **Protocol:** [Model Context Protocol](https://modelcontextprotocol.io/) over **stdio** (default for Cursor, Claude Desktop, Copilot agent adapters).
- **Package:** **`@archrad/deterministic`** publishes two binaries: **`archrad`** (CLI) and **`archrad-mcp`** (MCP). One implementation backs CLI + MCP.
- **Registry:** Optional `server.json` / manifest for MCP Registry; document install for Cursor “Add MCP server”.

## 4. IR payload size and `ir` vs `irPath`

| Concern | Guidance |
|---------|----------|
| **Inline `ir`** | Fine for small/medium graphs. Large JSON in a single tool call still stresses **host message limits** and **model context** — prefer **`irPath`** when the IR is big. |
| **`irPath`** | Absolute or relative path to a **single JSON file** (same shape as CLI `--ir`). Enforced **max file size 25 MiB** in the server (hard cap); if you exceed it, split validation or trim fixtures. |
| **Soft ceiling** | Below ~**5k–10k nodes**, inline JSON is usually workable if the host allows; above that, **`irPath` is recommended**. This is not a graph semantics limit — only practical transport/memory. |
| **Exactly one** | Provide **`ir`** **or** **`irPath`**, not both, not neither (for tools that need IR). |

**Privacy:** The OSS server does **not** add analytics or tracking parameters to tool responses. Optional product docs URLs use a stable path only (see **`archrad_suggest_fix`**).

## 5. Local testing

### 5.1 Smoke script (npm)

From the **`@archrad/deterministic`** package root (where **`package.json`** lives):

```bash
npm run build
npm run smoke:mcp
```

Exit code **0** means the MCP server spawned **`dist/mcp-server.js`**, listed tools, and successfully called **`archrad_suggest_fix`**.

### 5.2 MCP Inspector (browser UI)

```bash
npx @modelcontextprotocol/inspector node dist/mcp-server.js
```

Open the URL Inspector prints (often **http://localhost:6274**). Under **Tools**, run **`archrad_list_rule_codes`** (no args), then **`archrad_validate_ir`** with **`irPath`** set to **`fixtures/minimal-graph.json`** (relative paths work if the process was started with **cwd** set to the package root).

### 5.3 Cursor (MCP config + chat)

1. **Build** so **`dist/mcp-server.js`** exists (`npm run build`).
2. In Cursor **Settings → MCP**, add a server (exact JSON shape depends on Cursor version):
   - **Command:** `node` (or full path to `node.exe` on Windows).
   - **Args:** full path to **`dist/mcp-server.js`**.
   - **Cwd (recommended):** the deterministic package root (directory containing **`package.json`**). Relative **`irPath`** values like **`fixtures/minimal-graph.json`** resolve from this directory.
3. **Chat:** Cursor does not always show a “run tool” button for every server. Use **Agent** mode (or another mode that supports **tool use**) and ask explicitly, for example:

   **List codes:**

   > Use the MCP tool **`archrad_list_rule_codes`** (no arguments) and show me the raw JSON result.

   **Validate via file:**

   > Use the MCP tool **`archrad_validate_ir`** with **`irPath`** set to **`fixtures/minimal-graph.json`** (relative to the deterministic package). Show the full tool result.

   If the model says it cannot find the tool, the MCP server failed to start or the configured server name does not match — check Cursor’s MCP panel for errors.

4. **If `irPath` fails** with “file not found”, use the **absolute path** to **`fixtures/minimal-graph.json`**.

### 5.4 Success criteria

- **`archrad_list_rule_codes`:** JSON with a **`codes`** array.
- **`archrad_validate_ir`:** JSON with **`irStructuralFindings`**, **`irLintFindings`**, **`combined`**, **`ok`** — not a connection or file error.

## 6. Tools (0.1.5)

Tools are **idempotent** and **deterministic** where stated.

### 6.1 Core

| Tool | Input | Output | Notes |
|------|--------|--------|-------|
| **`archrad_validate_ir`** | `ir` **or** `irPath`; optional `policiesDirectory` | `{ ok, irStructuralFindings, irLintFindings, combined }` | Same as CLI validate. |
| **`archrad_lint_summary`** | `ir` **or** `irPath`; optional `policiesDirectory` | Short summary + counts | Agent-friendly. |
| **`archrad_validate_drift`** | `ir` **or** `irPath`; `target`; `exportDir`; optional policies, `skipIrLint` | Drift + export findings | Same as CLI `validate-drift`. |
| **`archrad_policy_packs_load`** | `directory` or `files[]` | `{ ok, ruleCount }` or errors | Compiles packs; does not return visitor functions over MCP. |

### 6.2 Static guidance (no generated architecture)

| Tool | Input | Output | Notes |
|------|--------|--------|-------|
| **`archrad_suggest_fix`** | `findingCode` (e.g. `IR-LINT-MISSING-AUTH-010`) | `{ ok, findingCode, title, remediation, docsUrl }` or `{ ok: false, error }` | **Curated text only** — not JSON Patch, not IR edits, not LLM output. **`docsUrl`** points to the **[`RULE_CODES.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/RULE_CODES.md)** section for that code on **GitHub** (canonical OSS; no query strings). Unknown built-in codes and **PolicyPack/org** ids return `ok: false` with a short explanation. |
| **`archrad_list_rule_codes`** | _(none)_ | `{ codes: string[] }` | Sorted list of built-in codes with static guidance. |

**Explicit non-goal:** **`archrad_suggest_fix` must not** return machine-generated graph edits or “patches” that invent services — that would be **generative** and would break the deterministic OSS contract.

### 6.3 Explicit non-goals (MVP)

- No automatic **code** generation inside MCP (keep **`export`** as CLI/CI).
- No remote calls to ArchRad Cloud unless a **separate authenticated** server is defined.
- No **tracking** query parameters in MCP tool payloads.

## 7. Resources (optional)

| Resource URI | Content |
|--------------|---------|
| `archrad://docs/ir-contract` | Pointer to bundled `IR_CONTRACT.md` snippet or link. |
| `archrad://schemas/ir-graph-v1` | JSON Schema for IR graph validation. |

## 8. Security

- **Local-only by default:** IR and paths stay on the user machine; **no telemetry** in the OSS server unless explicitly documented elsewhere.
- **Path sandbox:** Validate `exportDir` / `irPath` against workspace roots if the host passes a `workspaceRoot` (host-dependent).
- **Cloud MCP (future):** OAuth or API keys; never embed product secrets in OSS.

## 9. Launch narrative (copy bank)

- **One-liner:** *AI agents write code fast but drift from your architecture; ArchRad MCP gives them the same deterministic IR checks as CI, inside the agent loop.*
- **Show HN angle:** *Architectural conscience for Copilot / Cursor — IR-LINT before you merge.*

## 10. Related repo tasks

- **Quality:** Keep graph/lint work responsive so MCP tools stay usable on mid-size IRs.

## 11. Implementation checklist

1. ~~Node MCP server (`@modelcontextprotocol/sdk`), stdio transport.~~
2. ~~`archrad_validate_ir` + `archrad_validate_drift` + policy load + static `archrad_suggest_fix`.~~
3. README + **`docs/MCP.md`**: Cursor config, `ir` / `irPath`, local testing (smoke, Inspector, chat prompts).
4. Publish **`@archrad/deterministic`** to npm; subtree to public repo per release process.

---

*This document aligns OSS MCP scope with product strategy; update when adding Cloud-only tools.*
