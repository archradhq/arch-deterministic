/**
 * Architecture lint (IR-LINT-*): thin entry — parses graph then runs visitor registry in `lint-rules.ts`.
 */

import { buildParsedLintGraph } from './lint-graph.js';
import { runArchitectureLinting } from './lint-rules.js';
import type { IrStructuralFinding } from './ir-structural.js';

export function validateIrLint(ir: unknown): IrStructuralFinding[] {
  const g = buildParsedLintGraph(ir);
  if (!g) return [];
  return runArchitectureLinting(g);
}
