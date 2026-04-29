/**
 * `archrad explain <code>` — canonical rule metadata lookup.
 *
 * Wraps the `static-rule-guidance` registry with layer / category derivation
 * and a "did you mean?" suggestion for near-miss codes. Used by the CLI and
 * is safe to consume from tests and other tooling.
 */

import {
  getStaticRuleGuidance,
  listStaticRuleCodes,
} from './static-rule-guidance.js';

export type RuleLayer = 'structural' | 'lint' | 'drift' | 'other';

export type RuleExplanation = {
  code: string;
  title: string;
  remediation: string;
  docsUrl: string;
  /** Derived from the code prefix so PolicyPack codes still classify sensibly. */
  layer: RuleLayer;
};

/** Classify a rule code by its prefix. */
export function layerForCode(code: string): RuleLayer {
  if (code.startsWith('IR-STRUCT-')) return 'structural';
  if (code.startsWith('IR-LINT-')) return 'lint';
  if (code.startsWith('DRIFT-')) return 'drift';
  return 'other';
}

/** Normalise a user-supplied rule id: trim + uppercase, tolerant of lower-case input. */
export function normalizeRuleCode(input: string): string {
  return input.trim().toUpperCase();
}

/**
 * Levenshtein distance between two strings. Small, allocation-friendly
 * implementation; fine for our short rule-code inputs.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + cost);
      last = temp;
    }
  }
  return prev[b.length];
}

/**
 * Return up to `limit` rule codes that are close to `query` by edit distance
 * or shared prefix. Case-insensitive. Exact matches are excluded from the
 * suggestion list.
 */
export function suggestRuleCodes(query: string, limit = 5): string[] {
  const q = normalizeRuleCode(query);
  if (!q) return [];
  const all = listStaticRuleCodes();
  const scored = all
    .filter((c) => c !== q)
    .map((code) => {
      // Share-of-prefix heuristic: longer common prefix ⇒ lower effective distance.
      let shared = 0;
      const L = Math.min(code.length, q.length);
      while (shared < L && code.charCodeAt(shared) === q.charCodeAt(shared)) shared++;
      const dist = editDistance(code, q);
      const score = dist - Math.min(shared, 6);
      return { code, score, dist, shared };
    })
    // Keep anything with an edit distance <= half the query length, OR a
    // shared prefix of 4+ chars (e.g. typing "IR-LINT-" should suggest all
    // lint codes even if the body is wrong).
    .filter((s) => s.dist <= Math.max(3, Math.floor(q.length / 2)) || s.shared >= 4)
    .sort((a, b) => a.score - b.score || a.code.localeCompare(b.code));

  return scored.slice(0, limit).map((s) => s.code);
}

/**
 * Look up canonical explanation for `code`. Returns `null` when the code is
 * unknown. Codes are case-normalised (`ir-lint-missing-auth-010` works).
 */
export function explainRuleCode(code: string): RuleExplanation | null {
  const normalized = normalizeRuleCode(code);
  const g = getStaticRuleGuidance(normalized);
  if (!g) return null;
  return {
    code: normalized,
    title: g.title,
    remediation: g.remediation,
    docsUrl: g.docsUrl,
    layer: layerForCode(normalized),
  };
}

/** Grouped listing for `--list` / help output. */
export function listAllExplanations(): Record<RuleLayer, RuleExplanation[]> {
  const out: Record<RuleLayer, RuleExplanation[]> = {
    structural: [],
    lint: [],
    drift: [],
    other: [],
  };
  for (const code of listStaticRuleCodes()) {
    const exp = explainRuleCode(code);
    if (!exp) continue;
    out[exp.layer].push(exp);
  }
  return out;
}

/**
 * Pretty, multi-line rendering for terminal output. Mirrors the shape of
 * `printFindingsPretty` so users recognise the format instantly.
 */
export function formatExplanationLines(exp: RuleExplanation): string[] {
  const lines: string[] = [];
  lines.push(`${exp.code}`);
  lines.push(`Layer: ${exp.layer}`);
  lines.push('');
  lines.push(`Title:`);
  lines.push(`  ${exp.title}`);
  lines.push('');
  lines.push(`Fix:`);
  // Wrap remediation at a reasonable width for CLI output.
  for (const line of wrap(exp.remediation, 78, '  ')) lines.push(line);
  lines.push('');
  lines.push(`Docs: ${exp.docsUrl}`);
  return lines;
}

/**
 * Simple soft-wrap that preserves paragraph-style output without breaking
 * inline tokens. No dependency on an external wrap library.
 */
function wrap(text: string, width: number, indent: string): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = indent;
  for (const w of words) {
    if (current.length + w.length + 1 > width && current.length > indent.length) {
      lines.push(current);
      current = indent + w;
    } else if (current === indent) {
      current = indent + w;
    } else {
      current += ' ' + w;
    }
  }
  if (current.length > indent.length) lines.push(current);
  return lines;
}
