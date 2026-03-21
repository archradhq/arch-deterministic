import { describe, it, expect } from 'vitest';
import { shouldFailFromFindings, sortFindings } from './cli-findings.js';
import type { IrStructuralFinding } from './ir-structural.js';

describe('cli-findings', () => {
  it('shouldFailFromFindings on errors', () => {
    const findings: IrStructuralFinding[] = [
      { code: 'IR-STRUCT-X', severity: 'error', message: 'bad' },
    ];
    expect(shouldFailFromFindings(findings, {})).toBe(true);
  });

  it('shouldFailFromFindings on --fail-on-warning', () => {
    const findings: IrStructuralFinding[] = [
      { code: 'IR-LINT-X', severity: 'warning', message: 'meh' },
    ];
    expect(shouldFailFromFindings(findings, { failOnWarning: true })).toBe(true);
    expect(shouldFailFromFindings(findings, { failOnWarning: false })).toBe(false);
  });

  it('shouldFailFromFindings when warnings exceed maxWarnings', () => {
    const findings: IrStructuralFinding[] = [
      { code: 'A', severity: 'warning', message: '1' },
      { code: 'B', severity: 'warning', message: '2' },
    ];
    expect(shouldFailFromFindings(findings, { maxWarnings: 1 })).toBe(true);
    expect(shouldFailFromFindings(findings, { maxWarnings: 2 })).toBe(false);
  });

  it('sortFindings orders error before warning', () => {
    const sorted = sortFindings([
      { code: 'W', severity: 'warning', message: 'w' },
      { code: 'E', severity: 'error', message: 'e' },
    ]);
    expect(sorted[0].severity).toBe('error');
  });
});
