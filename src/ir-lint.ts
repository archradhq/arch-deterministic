/**
 * Architecture lint (IR-LINT-*): thin entry — parses graph then runs visitor registry in `lint-rules.ts`.
 */

import type { ParsedLintGraph } from './lint-graph.js';
import { buildParsedLintGraph, isParsedLintGraph } from './lint-graph.js';
import { runArchitectureLinting } from './lint-rules.js';
import type { IrStructuralFinding } from './ir-structural.js';

export type ValidateIrLintOptions = {
  /** Extra visitors after built-in IR-LINT-* (declarative policy packs, org rules). */
  policyRuleVisitors?: ReadonlyArray<(g: ParsedLintGraph) => IrStructuralFinding[]>;
};

/**
 * Run architecture lint (IR-LINT-*) plus optional policy visitors. If the IR cannot be parsed (invalid root, empty graph, etc.),
 * returns the same **structural** findings as `normalizeIrGraph` / `validateIrStructural` would surface
 * for that shape — callers that only invoke `validateIrLint` still see blockers instead of a silent `[]`.
 */
export function validateIrLint(ir: unknown, options?: ValidateIrLintOptions): IrStructuralFinding[] {
  const built = buildParsedLintGraph(ir);
  if (!isParsedLintGraph(built)) return built.findings;
  const base = runArchitectureLinting(built);
  const extra = options?.policyRuleVisitors?.flatMap((v) => v(built)) ?? [];
  return [...base, ...extra];
}
