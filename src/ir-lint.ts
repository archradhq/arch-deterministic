/**
 * Architecture lint (IR-LINT-*): thin entry — parses graph then runs visitor registry in `lint-rules.ts`.
 */

import { buildParsedLintGraph, isParsedLintGraph } from './lint-graph.js';
import { runArchitectureLinting } from './lint-rules.js';
import type { IrStructuralFinding } from './ir-structural.js';

/**
 * Run architecture lint (IR-LINT-*). If the IR cannot be parsed (invalid root, empty graph, etc.),
 * returns the same **structural** findings as `normalizeIrGraph` / `validateIrStructural` would surface
 * for that shape — callers that only invoke `validateIrLint` still see blockers instead of a silent `[]`.
 */
export function validateIrLint(ir: unknown): IrStructuralFinding[] {
  const built = buildParsedLintGraph(ir);
  if (!isParsedLintGraph(built)) return built.findings;
  return runArchitectureLinting(built);
}
