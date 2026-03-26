/**
 * Human-oriented CLI formatting for IR findings (structural + architecture lint).
 */

import type { IrStructuralFinding } from './ir-structural.js';

const ICON: Record<string, string> = {
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

function ttyColor(): { red: string; reset: string } {
  const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
  if (noColor || !process.stderr.isTTY) return { red: '', reset: '' };
  return { red: '\u001b[31m', reset: '\u001b[0m' };
}

/** Pretty multi-line output for terminal / CI logs */
export function formatFindingLines(f: IrStructuralFinding): string[] {
  const icon = ICON[f.severity] ?? '•';
  const { red, reset } = ttyColor();
  const head =
    f.code.startsWith('IR-LINT-') && red
      ? `${red}${icon} ${f.code}: ${f.message}${reset}`
      : `${icon} ${f.code}: ${f.message}`;
  const lines: string[] = [head];
  if (f.fixHint) lines.push(`   Fix: ${f.fixHint}`);
  if (f.suggestion) lines.push(`   Suggestion: ${f.suggestion}`);
  if (f.impact) lines.push(`   Impact: ${f.impact}`);
  return lines;
}

function printFindingBlock(findings: IrStructuralFinding[]): void {
  for (const f of findings) {
    for (const line of formatFindingLines(f)) {
      console.error(line);
    }
    console.error('');
  }
}

/**
 * Pretty-print findings. By default groups **IR structural (IR-STRUCT-*)** and **architecture lint (IR-LINT-*)** so both are obvious in CI logs.
 */
export function printFindingsPretty(
  findings: IrStructuralFinding[],
  header?: string,
  options?: { groupByLayer?: boolean }
): void {
  if (!findings.length) return;
  if (header) console.error(header);
  const group = options?.groupByLayer !== false;
  if (!group) {
    printFindingBlock(findings);
    return;
  }
  const structural = findings.filter((f) => f.code.startsWith('IR-STRUCT-'));
  const lint = findings.filter((f) => f.code.startsWith('IR-LINT-'));
  const other = findings.filter((f) => !f.code.startsWith('IR-STRUCT-') && !f.code.startsWith('IR-LINT-'));
  if (structural.length) {
    console.error('IR structural (IR-STRUCT-*):');
    printFindingBlock(structural);
  }
  if (lint.length) {
    console.error('Architecture lint (IR-LINT-*):');
    printFindingBlock(lint);
  }
  if (other.length) {
    console.error('Other findings:');
    printFindingBlock(other);
  }
}

export type ValidationExitPolicy = {
  /** When true, any warning fails the run (CI gate). */
  failOnWarning?: boolean;
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
  if (Boolean(policy.failOnWarning) && w > 0) return true;
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
