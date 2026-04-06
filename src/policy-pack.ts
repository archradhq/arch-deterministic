/**
 * Declarative org policy packs (YAML/JSON) — deterministic graph matchers on ParsedLintGraph.
 * Codes should use a stable prefix (e.g. ORG-*, ACME-*) to avoid colliding with IR-LINT-* / IR-STRUCT-*.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { ParsedLintGraph } from './lint-graph.js';
import { edgeEndpoints, nodeType } from './lint-graph.js';
import type { IrStructuralFinding } from './ir-structural.js';

export type PolicySeverity = 'error' | 'warning' | 'info';

/** Single-node selector: all provided predicates must match (AND). */
export type PolicyNodeSelectorV1 = {
  id?: string;
  type?: string | string[];
  /** All listed tags must appear on `node.metadata.tags` (array of strings). */
  tags?: string[];
};

export type PolicyEdgeMatchV1 = {
  from: PolicyNodeSelectorV1;
  to: PolicyNodeSelectorV1;
};

export type PolicyRuleV1 = {
  id: string;
  severity: PolicySeverity;
  message: string;
  fixHint?: string;
  match: {
    node?: PolicyNodeSelectorV1;
    edge?: PolicyEdgeMatchV1;
  };
};

export type PolicyPackMetadataV1 = {
  name?: string;
  org?: string;
};

export type PolicyPackDocumentV1 = {
  apiVersion: 'archrad/v1';
  kind: 'PolicyPack';
  metadata?: PolicyPackMetadataV1;
  rules: PolicyRuleV1[];
};

export type LoadPolicyPacksResult =
  | { ok: true; visitors: ReadonlyArray<(g: ParsedLintGraph) => IrStructuralFinding[]>; ruleCount: number }
  | { ok: false; errors: string[] };

function isNonEmptyRecord(x: unknown): x is Record<string, unknown> {
  return x != null && typeof x === 'object' && !Array.isArray(x);
}

function normalizeTypes(t: string | string[] | undefined): string[] | null {
  if (t == null) return null;
  const arr = Array.isArray(t) ? t : [t];
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

/** True if selector has at least one predicate (empty match-all forbidden for v1). */
function selectorHasPredicate(sel: PolicyNodeSelectorV1): boolean {
  if (sel.id != null && String(sel.id).trim() !== '') return true;
  if (sel.type != null) {
    const n = normalizeTypes(sel.type);
    if (n && n.length > 0) return true;
  }
  if (sel.tags != null && Array.isArray(sel.tags) && sel.tags.length > 0) return true;
  return false;
}

function nodeMatchesSelector(n: Record<string, unknown>, sel: PolicyNodeSelectorV1): boolean {
  if (sel.id != null && String(n.id ?? '') !== String(sel.id)) return false;
  const types = normalizeTypes(sel.type);
  if (types && types.length > 0) {
    const nt = nodeType(n);
    if (!types.includes(nt)) return false;
  }
  if (sel.tags != null && sel.tags.length > 0) {
    const meta = (n.metadata as Record<string, unknown> | undefined) ?? {};
    const raw = meta.tags;
    if (!Array.isArray(raw)) return false;
    const have = new Set(raw.map((x) => String(x).toLowerCase()));
    for (const t of sel.tags) {
      if (!have.has(String(t).toLowerCase())) return false;
    }
  }
  return true;
}

function compileRule(rule: PolicyRuleV1, source: string): (g: ParsedLintGraph) => IrStructuralFinding[] {
  if (!rule.id || typeof rule.id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(rule.id)) {
    throw new Error(`[${source}] invalid rule.id`);
  }
  if (!['error', 'warning', 'info'].includes(rule.severity)) {
    throw new Error(`[${source}] rule "${rule.id}": severity must be error | warning | info`);
  }
  if (!rule.message || typeof rule.message !== 'string') {
    throw new Error(`[${source}] rule "${rule.id}": message is required`);
  }
  const hasNode = rule.match?.node != null;
  const hasEdge = rule.match?.edge != null;
  if (hasNode === hasEdge) {
    throw new Error(`[${source}] rule "${rule.id}": specify exactly one of match.node or match.edge`);
  }

  if (hasNode) {
    const sel = rule.match.node!;
    if (!selectorHasPredicate(sel)) {
      throw new Error(`[${source}] rule "${rule.id}": match.node must include id, type, and/or tags`);
    }
    return (g: ParsedLintGraph) => {
      const findings: IrStructuralFinding[] = [];
      for (const [id, n] of g.nodeById) {
        if (nodeMatchesSelector(n, sel)) {
          findings.push({
            code: rule.id,
            severity: rule.severity,
            message: rule.message,
            nodeId: id,
            layer: 'lint',
            fixHint: rule.fixHint,
          });
        }
      }
      return findings;
    };
  }

  const edge = rule.match.edge!;
  if (!selectorHasPredicate(edge.from) || !selectorHasPredicate(edge.to)) {
    throw new Error(`[${source}] rule "${rule.id}": match.edge.from and match.edge.to must each include id, type, and/or tags`);
  }

  return (g: ParsedLintGraph) => {
    const findings: IrStructuralFinding[] = [];
    for (let edgeIndex = 0; edgeIndex < g.edges.length; edgeIndex++) {
      const e = g.edges[edgeIndex];
      if (!e || typeof e !== 'object') continue;
      const { from, to } = edgeEndpoints(e as Record<string, unknown>);
      if (!from || !to) continue;
      const a = g.nodeById.get(from);
      const b = g.nodeById.get(to);
      if (!a || !b) continue;
      if (nodeMatchesSelector(a, edge.from) && nodeMatchesSelector(b, edge.to)) {
        findings.push({
          code: rule.id,
          severity: rule.severity,
          message: rule.message,
          nodeId: to,
          edgeIndex,
          layer: 'lint',
          fixHint: rule.fixHint,
        });
      }
    }
    return findings;
  };
}

export type PolicyPackFileSource = {
  /** Virtual filename (must end with .yaml, .yml, or .json for parse rules). */
  name: string;
  content: string;
};

/**
 * Load policy packs from in-memory file sources (same semantics as {@link loadPolicyPacksFromDirectory}).
 * Use for ArchRad Cloud, tests, and API bodies — no filesystem required.
 */
export function loadPolicyPacksFromFiles(sources: ReadonlyArray<PolicyPackFileSource>): LoadPolicyPacksResult {
  const errors: string[] = [];
  const visitors: Array<(g: ParsedLintGraph) => IrStructuralFinding[]> = [];
  const seenIds = new Set<string>();
  let ruleCount = 0;

  const sorted = [...sources].sort((a, b) => a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    return { ok: false, errors: ['no policy sources provided'] };
  }

  for (const src of sorted) {
    const name = src.name?.trim() || 'unnamed';
    try {
      const doc = parseDocument(src.content, name);
      for (const rule of doc.rules) {
        if (seenIds.has(rule.id)) {
          errors.push(`duplicate rule id "${rule.id}" (file ${name})`);
          continue;
        }
        seenIds.add(rule.id);
        visitors.push(compileRule(rule, name));
        ruleCount += 1;
      }
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, visitors, ruleCount };
}

function parseDocument(text: string, filename: string): PolicyPackDocumentV1 {
  const ext = filename.toLowerCase();
  let data: unknown;
  if (ext.endsWith('.json')) {
    data = JSON.parse(text);
  } else if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
    data = yaml.load(text);
  } else {
    throw new Error(`unsupported policy file extension: ${filename}`);
  }
  if (!isNonEmptyRecord(data)) {
    throw new Error('policy document must be a JSON object');
  }
  const doc = data as Record<string, unknown>;
  if (doc.apiVersion !== 'archrad/v1') {
    throw new Error(`apiVersion must be "archrad/v1" (got ${String(doc.apiVersion)})`);
  }
  if (doc.kind !== 'PolicyPack') {
    throw new Error(`kind must be PolicyPack (got ${String(doc.kind)})`);
  }
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    throw new Error('rules must be a non-empty array');
  }
  return doc as unknown as PolicyPackDocumentV1;
}

/**
 * Load and compile all policy YAML/JSON files in a directory into lint visitors.
 * Filenames: `*.yaml`, `*.yml`, `*.json` (other files ignored).
 */
export async function loadPolicyPacksFromDirectory(dir: string): Promise<LoadPolicyPacksResult> {
  const root = resolve(dir);
  const errors: string[] = [];

  let names: string[];
  try {
    names = await readdir(root);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, errors: [`cannot read policies directory ${root}: ${err.message}`] };
  }

  const policyFiles = names.filter((n) => /\.(yaml|yml|json)$/i.test(n)).sort();

  if (policyFiles.length === 0) {
    return { ok: false, errors: [`no policy files (*.yaml, *.yml, *.json) in ${root}`] };
  }

  const sources: PolicyPackFileSource[] = [];
  for (const name of policyFiles) {
    const full = join(root, name);
    try {
      const text = await readFile(full, 'utf8');
      sources.push({ name, content: text });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      errors.push(`${full}: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return loadPolicyPacksFromFiles(sources);
}
