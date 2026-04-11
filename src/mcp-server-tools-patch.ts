/**
 * MCP tool catalog metadata (title + description) for archrad-mcp discoverability.
 * Keep in sync with registerTool handlers in mcp-server.ts.
 */

export const MCP_TOOL_ARCHRAD_VALIDATE_IR = {
  title: 'Validate IR — structural (IR-STRUCT-*) + architecture lint (IR-LINT-*) + PolicyPack',
  description: `Architecture-as-code validation: run this when you need to check whether an IR graph is valid or to list violations before export or drift checks.

Keywords: validate IR, architecture lint, IR-STRUCT, IR-LINT, policy pack, blueprint graph, nodes and edges.

Runs in one call:
1) Structural validation — graph shape, references, IR-STRUCT-* errors.
2) Architecture lint — design rules (auth, dead nodes, DB access, sync chains, etc.).
3) Optional PolicyPack rules — pass policiesDirectory to load YAML/JSON packs from disk.

Returns irStructuralFindings, irLintFindings, and combined (sorted by severity). ok is false when any finding has severity "error".

After results: call archrad_suggest_fix with a finding code for remediation text; use archrad_lint_summary for a short human-readable digest.

Input: provide exactly one of ir (inline JSON object) or irPath (path to .json). Large graphs: prefer irPath.`,
} as const;

export const MCP_TOOL_ARCHRAD_LINT_SUMMARY = {
  title: 'Lint summary — plain-text counts and top findings',
  description: `Human-readable summary of validation results: error/warning counts and up to 20 top findings (plain text).

Keywords: summary, PR comment, explain violations, readable lint output.

Use when you need a short narrative or comment, not structured JSON. For machine-actionable findings, use archrad_validate_ir instead.

Same inputs as archrad_validate_ir: ir or irPath, optional policiesDirectory. Provide only one of ir or irPath.`,
} as const;

export const MCP_TOOL_ARCHRAD_SUGGEST_FIX = {
  title: 'Suggest fix — static remediation for a built-in finding code',
  description: `Look up curated remediation steps and documentation URL for one built-in rule code (e.g. IR-LINT-MISSING-AUTH-010, IR-STRUCT-*, DRIFT-*).

Keywords: remediation, how to fix, rule code, docs link, IR-LINT, IR-STRUCT.

Does not return generated code patches or IR edits — only static guidance. PolicyPack and org-specific rule ids are not covered; see your YAML packs.

Call archrad_list_rule_codes to list codes that have static guidance.`,
} as const;

export const MCP_TOOL_ARCHRAD_LIST_RULE_CODES = {
  title: 'List rule codes — built-in codes with static guidance',
  description: `Returns the sorted list of built-in IR-STRUCT-*, IR-LINT-*, and DRIFT-* codes that archrad_suggest_fix can explain.

Keywords: catalog, all rules, rule list, documentation index.

Use before suggest_fix to confirm a code exists. Excludes PolicyPack custom ids. No arguments.`,
} as const;

export const MCP_TOOL_ARCHRAD_VALIDATE_DRIFT = {
  title: 'Validate drift — IR blueprint vs on-disk export (python | nodejs)',
  description: `Compare the architecture IR to generated code under exportDir and report drift (files that no longer match deterministic export).

Keywords: drift, CI, codegen diff, FastAPI, Express, Node, Python, validate export, architecture vs implementation.

Requires: ir or irPath, exportDir (absolute path to the export tree), and target. target must be "python" or "nodejs" (use "nodejs" for Node/TypeScript; do not use "node").

Optional: policiesDirectory, skipIrLint (true to skip IR-LINT and only check drift).

Returns driftFindings plus IR structural and lint findings from the same engine as CLI validate-drift.`,
} as const;

export const MCP_TOOL_ARCHRAD_POLICY_PACKS_LOAD = {
  title: 'Load PolicyPack — compile and validate packs (dry run, no IR)',
  description: `Validate PolicyPack YAML/JSON without running against a graph: syntax, rule ids, and compilation.

Keywords: policy pack, YAML rules, validate policies, org rules, offline check.

You usually do not need this before archrad_validate_ir or archrad_validate_drift — those accept policiesDirectory and load packs internally. Use this tool to debug pack files in isolation.

Provide either directory (folder path) or files (array of { name, content }), not both.`,
} as const;
