import { describe, it, expect } from 'vitest';
import {
  explainRuleCode,
  formatExplanationLines,
  layerForCode,
  listAllExplanations,
  normalizeRuleCode,
  suggestRuleCodes,
} from './explain.js';

describe('explain — layerForCode', () => {
  it('classifies IR-STRUCT-* as structural', () => {
    expect(layerForCode('IR-STRUCT-NODE_NO_ID')).toBe('structural');
  });
  it('classifies IR-LINT-* as lint', () => {
    expect(layerForCode('IR-LINT-DIRECT-DB-ACCESS-002')).toBe('lint');
  });
  it('classifies DRIFT-* as drift', () => {
    expect(layerForCode('DRIFT-MISSING')).toBe('drift');
  });
  it('classifies anything else as other', () => {
    expect(layerForCode('ORG-CUSTOM-001')).toBe('other');
    expect(layerForCode('')).toBe('other');
  });
});

describe('explain — normalizeRuleCode', () => {
  it('uppercases and trims', () => {
    expect(normalizeRuleCode('  ir-lint-missing-auth-010  ')).toBe(
      'IR-LINT-MISSING-AUTH-010'
    );
  });
});

describe('explain — explainRuleCode', () => {
  it('returns the registered entry for a known code', () => {
    const e = explainRuleCode('IR-LINT-DIRECT-DB-ACCESS-002');
    expect(e).not.toBeNull();
    expect(e?.code).toBe('IR-LINT-DIRECT-DB-ACCESS-002');
    expect(e?.layer).toBe('lint');
    expect(e?.title).toMatch(/datastore/i);
    expect(e?.remediation.length).toBeGreaterThan(20);
    expect(e?.docsUrl).toMatch(/RULE_CODES\.md#/);
  });

  it('is case-insensitive on input', () => {
    const e = explainRuleCode('ir-lint-direct-db-access-002');
    expect(e?.code).toBe('IR-LINT-DIRECT-DB-ACCESS-002');
  });

  it('returns null for unknown codes', () => {
    expect(explainRuleCode('IR-LINT-NOT-A-REAL-CODE')).toBeNull();
  });

  it('covers representative structural / lint / drift codes', () => {
    expect(explainRuleCode('IR-STRUCT-CYCLE')?.layer).toBe('structural');
    expect(explainRuleCode('IR-LINT-MISSING-AUTH-010')?.layer).toBe('lint');
    expect(explainRuleCode('DRIFT-MODIFIED')?.layer).toBe('drift');
  });
});

describe('explain — suggestRuleCodes', () => {
  it('returns close matches for a typo', () => {
    const suggestions = suggestRuleCodes('IR-LINT-MISSING-AUTH-01'); // missing trailing zero
    expect(suggestions).toContain('IR-LINT-MISSING-AUTH-010');
  });

  it('returns related codes when given a layer prefix', () => {
    const suggestions = suggestRuleCodes('IR-LINT-');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.startsWith('IR-LINT-'))).toBe(true);
  });

  it('returns empty array for empty query', () => {
    expect(suggestRuleCodes('')).toEqual([]);
  });

  it('does not include the exact match as a suggestion', () => {
    const suggestions = suggestRuleCodes('IR-LINT-DIRECT-DB-ACCESS-002');
    expect(suggestions).not.toContain('IR-LINT-DIRECT-DB-ACCESS-002');
  });

  it('caps results at the provided limit', () => {
    const suggestions = suggestRuleCodes('IR-LINT-', 3);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });
});

describe('explain — listAllExplanations', () => {
  it('groups entries by layer and is non-empty in every real bucket', () => {
    const grouped = listAllExplanations();
    expect(grouped.structural.length).toBeGreaterThan(0);
    expect(grouped.lint.length).toBeGreaterThan(0);
    expect(grouped.drift.length).toBeGreaterThan(0);
    // Every entry's own .layer matches its bucket.
    for (const e of grouped.structural) expect(e.layer).toBe('structural');
    for (const e of grouped.lint) expect(e.layer).toBe('lint');
    for (const e of grouped.drift) expect(e.layer).toBe('drift');
  });
});

describe('explain — formatExplanationLines', () => {
  it('emits code, layer, title, fix, and docs URL', () => {
    const e = explainRuleCode('IR-LINT-MISSING-AUTH-010')!;
    const lines = formatExplanationLines(e);
    const blob = lines.join('\n');
    expect(blob).toContain('IR-LINT-MISSING-AUTH-010');
    expect(blob).toContain('Layer: lint');
    expect(blob).toContain('Title:');
    expect(blob).toContain('Fix:');
    expect(blob).toMatch(/Docs: https?:\/\//);
  });

  it('soft-wraps long remediation paragraphs', () => {
    const e = explainRuleCode('IR-LINT-MISSING-AUTH-010')!;
    const lines = formatExplanationLines(e);
    for (const l of lines) {
      // Indented wrap lines should stay within ~80 columns.
      if (l.startsWith('  ')) expect(l.length).toBeLessThanOrEqual(80);
    }
  });
});
