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

const VERSION = '0.1.5';

/** Hard cap for `irPath` reads (see docs/MCP.md). */
const MAX_IR_FILE_BYTES = 25 * 1024 * 1024;

const irSourceSchema = {
  ir: z.unknown().optional(),
  irPath: z.string().optional(),
};

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
    'archrad_suggest_fix',
    {
      title: 'Static remediation for a finding code',
      description:
        'Deterministic title, remediation text, and canonical docs URL for a built-in IR-STRUCT / IR-LINT / DRIFT code. Does not generate patches or IR edits.',
      inputSchema: {
        findingCode: z.string().min(1),
      },
    },
    async (args) => {
      const g = getStaticRuleGuidance(args.findingCode);
      if (!g) {
        return jsonResult({
          ok: false,
          findingCode: args.findingCode,
          error:
            'Unknown built-in code. PolicyPack and org rules use custom rule ids in YAML — see your pack. Use archrad_list_rule_codes for built-in codes.',
        });
      }
      return jsonResult({ ok: true, ...g });
    },
  );

  server.registerTool(
    'archrad_list_rule_codes',
    {
      title: 'List built-in rule codes',
      description:
        'Sorted list of IR-STRUCT-*, IR-LINT-*, and DRIFT-* codes that have static guidance via archrad_suggest_fix.',
      inputSchema: {},
    },
    async () => jsonResult({ codes: listStaticRuleCodes() }),
  );

  server.registerTool(
    'archrad_validate_ir',
    {
      title: 'Validate IR (structural + IR-LINT)',
      description:
        'Run deterministic structural validation (IR-STRUCT-*) and architecture lint (IR-LINT-*). Pass `ir` inline or `irPath` to a JSON file (recommended for large graphs). Optional local PolicyPack directory.',
      inputSchema: {
        ...irSourceSchema,
        policiesDirectory: z.string().optional(),
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
      title: 'Lint summary',
      description:
        'Short text summary of IR structural + lint findings. Use `ir` or `irPath` (see archrad_validate_ir).',
      inputSchema: {
        ...irSourceSchema,
        policiesDirectory: z.string().optional(),
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
      return jsonResult({ summary: lines.join('\n'), counts: { total: combined.length, errors: errors.length, warnings: warnings.length } });
    },
  );

  server.registerTool(
    'archrad_validate_drift',
    {
      title: 'Validate drift',
      description:
        'Compare on-disk export to a fresh deterministic export. Pass `ir` or `irPath` (JSON file).',
      inputSchema: {
        ...irSourceSchema,
        target: z.enum(['python', 'node', 'nodejs']),
        exportDir: z.string(),
        policiesDirectory: z.string().optional(),
        skipIrLint: z.boolean().optional(),
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
      title: 'Load policy packs',
      description: 'Compile PolicyPack YAML/JSON from a directory or from in-memory file list.',
      inputSchema: {
        directory: z.string().optional(),
        files: z
          .array(z.object({ name: z.string(), content: z.string() }))
          .optional(),
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
      return jsonResult({ ok: false, error: 'Provide `directory` or `files`.' });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('archrad-mcp:', err);
  process.exitCode = 1;
});
