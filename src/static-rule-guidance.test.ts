import { describe, expect, it } from 'vitest';
import { docsUrlForFindingCode, getStaticRuleGuidance, listStaticRuleCodes } from './static-rule-guidance.js';

describe('static-rule-guidance', () => {
  it('returns guidance for IR-LINT-MISSING-AUTH-010', () => {
    const g = getStaticRuleGuidance('IR-LINT-MISSING-AUTH-010');
    expect(g).not.toBeNull();
    expect(g!.findingCode).toBe('IR-LINT-MISSING-AUTH-010');
    expect(g!.title).toContain('auth');
    expect(g!.remediation.length).toBeGreaterThan(20);
    expect(g!.docsUrl).toBe(docsUrlForFindingCode('IR-LINT-MISSING-AUTH-010'));
    expect(g!.docsUrl).not.toMatch(/[?&]ref=/);
  });

  it('returns null for unknown codes', () => {
    expect(getStaticRuleGuidance('ORG-CUSTOM-001')).toBeNull();
    expect(getStaticRuleGuidance('')).toBeNull();
  });

  it('listStaticRuleCodes is sorted and includes structural + drift', () => {
    const c = listStaticRuleCodes();
    expect(c).toEqual([...c].sort());
    expect(c).toContain('IR-STRUCT-CYCLE');
    expect(c).toContain('DRIFT-MISSING');
  });
});
