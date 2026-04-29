# ArchRad MCP Server — user guide

**Audience:** Registry listings (e.g. mcp.so), README deep-links, and operators who want a single accurate overview. For transport details, IR size limits, and testing recipes, see [`MCP.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/MCP.md).

## What is ArchRad MCP Server?

ArchRad MCP Server gives AI coding agents (Claude Desktop, Cursor, and other MCP-capable hosts) **deterministic** architecture governance. When your agent designs or edits a system graph, ArchRad validates the **IR** (intermediate representation) against structural rules and **IR-LINT** — before anything is committed.

**No LLM in the validation loop.** Same engine as the `archrad` CLI. **Apache-2.0.**

## Installation

```bash
npm install -g @archrad/deterministic
```

The MCP server binary **`archrad-mcp`** ships with this package (`package.json` → `bin`).

**Alternative (no global install):** many hosts accept `npx`:

```json
{
  "mcpServers": {
    "archrad": {
      "command": "npx",
      "args": ["-y", "--package=@archrad/deterministic", "archrad-mcp"]
    }
  }
}
```

On Windows, if the command is not on `PATH`, use the full path to `node` and to `dist/mcp-server.js` from a local clone after `npm run build` — see [`MCP.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/MCP.md) §5.3.

## Claude Desktop configuration

```json
{
  "mcpServers": {
    "archrad": {
      "command": "archrad-mcp",
      "args": []
    }
  }
}
```

## MCP tools

| Tool | Purpose |
|------|---------|
| **`archrad_validate_ir`** | Validate IR JSON against structural rules and built-in IR-LINT, with optional **PolicyPack** from `policiesDirectory`. Returns `irStructuralFindings`, `irLintFindings`, and a sorted `combined` list. Curated remediation text for a code is a **separate** call to `archrad_suggest_fix`. |
| **`archrad_lint_summary`** | Short summary and counts of findings (same inputs as validate: `ir` / `irPath`, optional `policiesDirectory`). |
| **`archrad_validate_drift`** | Compare IR to an on-disk **export directory** (`exportDir`) for a given **`target`**: `python` or `nodejs` only. Surfaces drift-class findings such as **`DRIFT-MISSING`**, **`DRIFT-MODIFIED`**, **`DRIFT-EXTRA`**, and **`DRIFT-NO-EXPORT`**, plus lint/structural output from the same pipeline when enabled. Optional `policiesDirectory`, optional `skipIrLint`. |
| **`archrad_policy_packs_load`** | **Compile / smoke-check** PolicyPack YAML or JSON from a **`directory`** or in-memory **`files`** list. Returns `{ ok, ruleCount }` or errors. **Does not register packs for later tools** — the process is stateless. To lint with a pack, pass the same path as **`policiesDirectory`** on `archrad_validate_ir`, `archrad_lint_summary`, or `archrad_validate_drift`. |
| **`archrad_suggest_fix`** | Static, curated guidance for a **built-in** rule id (e.g. `IR-LINT-MISSING-AUTH-010`). Not LLM output; not automatic graph patches. |
| **`archrad_list_rule_codes`** | Returns **`{ codes: string[] }`** — sorted built-in codes that have static guidance in OSS. For descriptions, severity, and compliance language, use **`archrad_suggest_fix`** per code or **[`RULE_CODES.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/RULE_CODES.md)**. |

Explicit non-goals for OSS MCP are summarized in [`MCP.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/MCP.md) §6–§7.

## CLI capabilities (not MCP)

These run in the terminal, not as MCP tools — use them to **produce IR** before calling `archrad_validate_ir`:

- `archrad ingest openapi --spec <url-or-file>` — OpenAPI 3.x → IR  
- `archrad init --from docker-compose.yml` — docker-compose → IR  
- `archrad ingest backstage --catalog <dir>` — Backstage catalog → IR  

Full flags: **[`CLI_REFERENCE.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/CLI_REFERENCE.md)**.

## Example IR-LINT rules

Sample of built-in codes (canonical catalog: **[`RULE_CODES.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/RULE_CODES.md)**):

| Rule | Description |
|------|-------------|
| IR-LINT-DIRECT-DB-001 | Service calls database directly, bypassing service layer |
| IR-LINT-DIRECT-DB-ACCESS-002 | HTTP-facing service has direct edge to database |
| IR-LINT-MISSING-AUTH-010 | HTTP entry point has no auth boundary |
| IR-LINT-DEAD-NODE-011 | Node with no inbound or outbound edges |
| IR-LINT-MULTIPLE-HTTP-ENTRIES-009 | Multiple HTTP entry points with no gateway |
| IR-LINT-NO-HEALTHCHECK-003 | No health or readiness endpoint defined |

## Real-world example (Swagger Petstore)

The repo includes a script that clones public YAML via the GitHub tree API, classifies OpenAPI vs blueprint, and validates. Run from the **`@archrad/deterministic` package root** after a build:

```bash
cd packages/deterministic   # adjust if your clone layout differs
npm run build
node scripts/github-validate-samples.mjs --repo swagger-api/swagger-petstore --max 5
```

Findings vary by spec revision; treat output as an **illustrative** run, not a fixed marketing scorecard.

## Enterprise — remote MCP with org policies

For teams using ArchRad Cloud, **`@archrad/remote-mcp`** is an HTTP MCP gateway that fetches org **PolicyPack** context from the API using a per-user or per-org bearer token, so agents do not need local policy files. Deployment (e.g. Cloud Run), token issuance, and **what is retained for compliance evidence** are product-specific — see **`packages/archrad-remote-mcp/README.md`** in this monorepo and your ArchRad Cloud documentation. Do not promise a specific audit trail in OSS copy without matching product/legal language.

## Links

- **npm:** [@archrad/deterministic](https://www.npmjs.com/package/@archrad/deterministic)  
- **GitHub:** [arch-deterministic](https://github.com/archradhq/arch-deterministic)  
- **Platform:** [archrad.com](https://archrad.com)  
- **License:** Apache-2.0  
- **Spec + testing:** [`MCP.md`](https://github.com/archradhq/arch-deterministic/blob/main/docs/MCP.md)  
