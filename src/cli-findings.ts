/**
 * Human-oriented CLI formatting for IR findings (structural + architecture lint).
 */

import type { IrStructuralFinding } from './ir-structural.js';

const ICON: Record<string, string> = {
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

/** Pretty multi-line output for terminal / CI logs */
export function formatFindingLines(f: IrStructuralFinding): string[] {
  const icon = ICON[f.severity] ?? '•';
  const lines: string[] = [`${icon} ${f.code}: ${f.message}`];
  if (f.fixHint) lines.push(`   Fix: ${f.fixHint}`);
  if (f.suggestion) lines.push(`   Suggestion: ${f.suggestion}`);
  if (f.impact) lines.push(`   Impact: ${f.impact}`);
  return lines;
}

export function printFindingsPretty(findings: IrStructuralFinding[], header?: string): void {
  if (!findings.length) return;
  if (header) console.error(header);
  for (const f of findings) {
    for (const line of formatFindingLines(f)) {
      console.error(line);
    }
    console.error('');
  }
}

export type ValidationExitPolicy = {
  failOnWarning: boolean;
  /** Fail when warning count is strictly greater than this (undefined = no limit) */
  maxWarnings?: number;
};

export function countBySeverity(findings: IrStructuralFinding[], sev: IrStructuralFinding['severity']): number {
  return findings.filter((f) => f.severity === sev).length;
}

/** true = exit with failure */
export function shouldFailFromFindings(findings: IrStructuralFinding[], policy: ValidationExitPolicy): boolean {
  if (findings.some((f) => f.severity === 'error')) return true;
  const w = countBySeverity(findings, 'warning');
  if (policy.failOnWarning && w > 0) return true;
  if (policy.maxWarnings != null && w > policy.maxWarnings) return true;
  return false;
}

const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

export function sortFindings(findings: IrStructuralFinding[]): IrStructuralFinding[] {
  return [...findings].sort((a, b) => {
    const d = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    return d !== 0 ? d : a.code.localeCompare(b.code);
  });
}
