#!/usr/bin/env node
/**
 * archrad-mcp — Model Context Protocol server (stdio) for deterministic IR validation,
 * architecture lint, policy packs, and drift checks. Uses the same engine as `archrad` CLI.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  normalizeIrGraph,
  validateIrStructural,
  validateIrLint,
  runValidateDrift,
  sortFindings,
  loadPolicyPacksFromDirectory,
  loadPolicyPacksFromFiles,
} from './index.js';
import type { ValidateIrLintOptions } from './ir-lint.js';
import { getStaticRuleGuidance, listStaticRuleCodes } from './static-rule-guidance.js';
import {
  MCP_TOOL_ARCHRAD_LIST_RULE_CODES,
  MCP_TOOL_ARCHRAD_LINT_SUMMARY,
  MCP_TOOL_ARCHRAD_POLICY_PACKS_LOAD,
  MCP_TOOL_ARCHRAD_SUGGEST_FIX,
  MCP_TOOL_ARCHRAD_VALIDATE_DRIFT,
  MCP_TOOL_ARCHRAD_VALIDATE_IR,
} from './mcp-server-tools-patch.js';

const VERSION = '0.1.6';

/** Hard cap for `irPath` reads (see docs/MCP.md). */
const MAX_IR_FILE_BYTES = 25 * 1024 * 1024;

function jsonResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

async function loadIrFromArgs(args: {
  ir?: unknown;
  irPath?: string;
}): Promise<{ ok: true; ir: unknown } | { ok: false; error: string }> {
  const hasInline = args.ir !== undefined;
  const hasPath = args.irPath != null && String(args.irPath).trim() !== '';
  if (hasInline && hasPath) {
    return { ok: false, error: 'Provide only one of `ir` or `irPath`.' };
  }
  if (hasPath) {
    const p = resolve(args.irPath!);
    let st;
    try {
      st = await stat(p);
    } catch (e) {
      return { ok: false, error: `irPath not readable: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!st.isFile()) {
      return { ok: false, error: `irPath is not a file: ${p}` };
    }
    if (st.size > MAX_IR_FILE_BYTES) {
      return {
        ok: false,
        error: `IR file is ${st.size} bytes (max ${MAX_IR_FILE_BYTES}). Split the graph, trim fixtures, or validate smaller subgraphs.`,
      };
    }
    const raw = await readFile(p, 'utf8');
    try {
      return { ok: true, ir: JSON.parse(raw) };
    } catch (e) {
      return { ok: false, error: `Invalid JSON in irPath: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (hasInline) {
    return { ok: true, ir: args.ir };
  }
  return { ok: false, error: 'Provide `ir` (inline JSON) or `irPath` (path to IR JSON file).' };
}

async function main() {
  const server = new McpServer({
    name: 'archrad-deterministic',
    version: VERSION,
  });

  server.registerTool(
    'archrad_validate_ir',
    {
      title: MCP_TOOL_ARCHRAD_VALIDATE_IR.title,
      description: MCP_TOOL_ARCHRAD_VALIDATE_IR.description,
      inputSchema: {
        ir: z.unknown().optional().describe('Inline IR graph as a JSON object. Use for small graphs only.'),
        irPath: z.string().optional().describe('Absolute or relative path to an IR JSON file. Preferred for large graphs.'),
        policiesDirectory: z
          .string()
          .optional()
          .describe('Path to a directory of PolicyPack YAML/JSON files. Optional — omit if you have no custom rules.'),
      },
    },
    async (args) => {
      const loaded = await loadIrFromArgs(args);
      if (!loaded.ok) return jsonResult({ ok: false, phase: 'input', error: loaded.error });
      const irRaw = loaded.ir;
      const norm = normalizeIrGraph(irRaw);
      if ('findings' in norm) {
        return jsonResult({ ok: false, phase: 'normalize', findings: norm.findings });
      }
      const structural = validateIrStructural(irRaw);
      let policyRuleVisitors: ValidateIrLintOptions['policyRuleVisitors'] | undefined;
      if (args.policiesDirectory) {
        const dir = resolve(args.policiesDirectory);
        const packLoaded = await loadPolicyPacksFromDirectory(dir);
        if (!packLoaded.ok) {
          return jsonResult({ ok: false, phase: 'policy_packs', errors: packLoaded.errors });
        }
        policyRuleVisitors = packLoaded.visitors;
      }
      const irLintFindings = validateIrLint(irRaw, { policyRuleVisitors });
      const combined = sortFindings([...structural, ...irLintFindings]);
      return jsonResult({
        ok: combined.every((f) => f.severity !== 'error'),
        irStructuralFindings: structural,
        irLintFindings,
        combined,
      });
    },
  );

  server.registerTool(
    'archrad_lint_summary',
    {
      title: MCP_TOOL_ARCHRAD_LINT_SUMMARY.title,
      description: MCP_TOOL_ARCHRAD_LINT_SUMMARY.description,
      inputSchema: {
        ir: z.unknown().optional().describe('Inline IR graph as a JSON object.'),
        irPath: z.string().optional().describe('Absolute or relative path to an IR JSON file.'),
        policiesDirectory: z
          .string()
          .optional()
          .describe('Path to a directory of PolicyPack YAML/JSON files. Optional.'),
      },
    },
    async (args) => {
      const loaded = await loadIrFromArgs(args);
      if (!loaded.ok) return jsonResult({ summary: loaded.error });
      const irRaw = loaded.ir;
      const norm = normalizeIrGraph(irRaw);
      if ('findings' in norm) {
        return jsonResult({ summary: `Normalize failed: ${norm.findings.map((f) => f.message).join('; ')}` });
      }
      const structural = validateIrStructural(irRaw);
      let policyRuleVisitors: ValidateIrLintOptions['policyRuleVisitors'] | undefined;
      if (args.policiesDirectory) {
        const packLoaded = await loadPolicyPacksFromDirectory(resolve(args.policiesDirectory));
        if (!packLoaded.ok) {
          return jsonResult({ summary: `Policy packs failed: ${packLoaded.errors.join('; ')}` });
        }
        policyRuleVisitors = packLoaded.visitors;
      }
      const irLintFindings = validateIrLint(irRaw, { policyRuleVisitors });
      const combined = sortFindings([...structural, ...irLintFindings]);
      const errors = combined.filter((f) => f.severity === 'error');
      const warnings = combined.filter((f) => f.severity === 'warning');
      const lines = [
        `Findings: ${combined.length} (${errors.length} errors, ${warnings.length} warnings).`,
        ...combined.slice(0, 20).map((f) => `- [${f.code}] ${f.message}`),
      ];
      if (combined.length > 20) lines.push(`… and ${combined.length - 20} more.`);
      return jsonResult({
        summary: lines.join('\n'),
        counts: { total: combined.length, errors: errors.length, warnings: warnings.length },
      });
    },
  );

  server.registerTool(
    'archrad_suggest_fix',
    {
      title: MCP_TOOL_ARCHRAD_SUGGEST_FIX.title,
      description: MCP_TOOL_ARCHRAD_SUGGEST_FIX.description,
      inputSchema: {
        findingCode: z.string().min(1).describe('The finding code to look up, e.g. "IR-LINT-MISSING-AUTH-010".'),
      },
    },
    async (args) => {
      const g = getStaticRuleGuidance(args.findingCode);
      if (!g) {
        return jsonResult({
          ok: false,
          findingCode: args.findingCode,
          error:
            'Unknown built-in code. PolicyPack and org rules use custom rule ids in YAML — see your pack. Call archrad_list_rule_codes to see all built-in codes with static guidance.',
        });
      }
      return jsonResult({ ok: true, ...g });
    },
  );

  server.registerTool(
    'archrad_list_rule_codes',
    {
      title: MCP_TOOL_ARCHRAD_LIST_RULE_CODES.title,
      description: MCP_TOOL_ARCHRAD_LIST_RULE_CODES.description,
      inputSchema: {},
    },
    async () => jsonResult({ codes: listStaticRuleCodes() }),
  );

  server.registerTool(
    'archrad_validate_drift',
    {
      title: MCP_TOOL_ARCHRAD_VALIDATE_DRIFT.title,
      description: MCP_TOOL_ARCHRAD_VALIDATE_DRIFT.description,
      inputSchema: {
        ir: z.unknown().optional().describe('Inline IR graph as a JSON object.'),
        irPath: z.string().optional().describe('Absolute or relative path to an IR JSON file.'),
        target: z
          .enum(['python', 'nodejs'])
          .describe('Export target language. Use "nodejs" for Node.js/TypeScript, "python" for Python.'),
        exportDir: z
          .string()
          .describe('Absolute path to the on-disk export directory to compare against the IR.'),
        policiesDirectory: z.string().optional().describe('Path to a PolicyPack directory. Optional.'),
        skipIrLint: z.boolean().optional().describe('Set to true to skip IR-LINT checks and only check for drift. Default: false.'),
      },
    },
    async (args) => {
      const loaded = await loadIrFromArgs(args);
      if (!loaded.ok) return jsonResult({ ok: false, phase: 'input', error: loaded.error });
      const irRaw = loaded.ir;
      const norm = normalizeIrGraph(irRaw);
      if ('findings' in norm) {
        return jsonResult({ ok: false, phase: 'normalize', findings: norm.findings });
      }
      const actualIR =
        irRaw && typeof irRaw === 'object' && irRaw !== null && 'graph' in irRaw
          ? (irRaw as Record<string, unknown>)
          : { graph: norm.graph };
      let policyRuleVisitors: ValidateIrLintOptions['policyRuleVisitors'] | undefined;
      if (args.policiesDirectory) {
        const packLoaded = await loadPolicyPacksFromDirectory(resolve(args.policiesDirectory));
        if (!packLoaded.ok) {
          return jsonResult({ ok: false, phase: 'policy_packs', errors: packLoaded.errors });
        }
        policyRuleVisitors = packLoaded.visitors;
      }
      const outDir = resolve(args.exportDir);
      const result = await runValidateDrift(actualIR, args.target, outDir, {
        skipIrLint: args.skipIrLint ?? false,
        policyRuleVisitors,
      });
      return jsonResult({
        ok: result.ok,
        driftFindings: result.driftFindings,
        extraBlocking: result.extraBlocking,
        irStructuralFindings: result.exportResult.irStructuralFindings,
        irLintFindings: result.exportResult.irLintFindings,
      });
    },
  );

  server.registerTool(
    'archrad_policy_packs_load',
    {
      title: MCP_TOOL_ARCHRAD_POLICY_PACKS_LOAD.title,
      description: MCP_TOOL_ARCHRAD_POLICY_PACKS_LOAD.description,
      inputSchema: {
        directory: z.string().optional().describe('Path to a directory of PolicyPack YAML/JSON files.'),
        files: z
          .array(
            z.object({
              name: z.string().describe('Filename, e.g. "auth-rules.yaml".'),
              content: z.string().describe('Raw file content as a string.'),
            }),
          )
          .optional()
          .describe('In-memory file list. Use when you have policy content as strings rather than on-disk files.'),
      },
    },
    async (args) => {
      if (args.files && args.files.length > 0) {
        const loaded = loadPolicyPacksFromFiles(
          args.files.map((f) => ({ name: f.name, content: f.content })),
        );
        if (!loaded.ok) {
          return jsonResult({ ok: false, errors: loaded.errors });
        }
        return jsonResult({ ok: true, ruleCount: loaded.ruleCount });
      }
      if (args.directory) {
        const loaded = await loadPolicyPacksFromDirectory(resolve(args.directory));
        if (!loaded.ok) {
          return jsonResult({ ok: false, errors: loaded.errors });
        }
        return jsonResult({ ok: true, ruleCount: loaded.ruleCount });
      }
      return jsonResult({
        ok: false,
        error: 'Provide either directory (path string) or files (array of {name, content}).',
      });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('archrad-mcp:', err);
  process.exitCode = 1;
});
