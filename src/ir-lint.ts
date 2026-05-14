/**
 * Architecture lint (IR-LINT-*): thin entry — parses graph then runs visitor registry in `lint-rules.ts`.
 */

import type { ParsedLintGraph } from './lint-graph.js';
import { buildParsedLintGraph, isParsedLintGraph } from './lint-graph.js';
import { MONOLITH_RELAXED_PROFILE_OMIT_CODES, runArchitectureLinting } from './lint-rules.js';
import type { IrStructuralFinding } from './ir-structural.js';

export type LintProfileId = 'default' | 'monolith-relaxed';

export type ValidateIrLintOptions = {
  /**
   * Built-in rule profile. **`monolith-relaxed`** omits **`IR-LINT-DIRECT-DB-ACCESS-002`**,
   * **`IR-LINT-MISSING-AUTH-010`**, **`IR-LINT-MULTIPLE-HTTP-ENTRIES-009`** — common for Django/Rails backends.
   */
  lintProfile?: LintProfileId;
  /** Extra visitors after built-in IR-LINT-* (declarative policy packs, org rules). */
  policyRuleVisitors?: ReadonlyArray<(g: ParsedLintGraph) => IrStructuralFinding[]>;
};

function builtInLintOmitCodes(profile?: LintProfileId): ReadonlySet<string> | undefined {
  if (profile === 'monolith-relaxed') return MONOLITH_RELAXED_PROFILE_OMIT_CODES;
  return undefined;
}

/**
 * Run architecture lint (IR-LINT-*) plus optional policy visitors. If the IR cannot be parsed (invalid root, empty graph, etc.),
 * returns the same **structural** findings as `normalizeIrGraph` / `validateIrStructural` would surface
 * for that shape — callers that only invoke `validateIrLint` still see blockers instead of a silent `[]`.
 */
export function validateIrLint(ir: unknown, options?: ValidateIrLintOptions): IrStructuralFinding[] {
  const built = buildParsedLintGraph(ir);
  if (!isParsedLintGraph(built)) return built.findings;
  const omit = builtInLintOmitCodes(options?.lintProfile);
  const base = runArchitectureLinting(built, omit ? { omitFindingCodes: omit } : undefined);
  const extra = options?.policyRuleVisitors?.flatMap((v) => v(built)) ?? [];
  return [...base, ...extra];
}
