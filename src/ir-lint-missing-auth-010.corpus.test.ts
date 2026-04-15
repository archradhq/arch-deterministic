/**
 * Training / eval corpus for IR-LINT-MISSING-AUTH-010 (20 graphs).
 * Raw examples live in `archlora/corpus/corpus-auth-010-pairs.json`.
 * `augmentCorpusGraph` strips IR-LINT-NO-HEALTHCHECK-003 / IR-LINT-DEAD-NODE-011 / IR-LINT-SYNC-CHAIN-001 noise
 * so the oracle focuses on **010** (and **009** when multiple HTTP entries exist).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateIrLint } from './ir-lint.js';
import { augmentCorpusGraph } from './missing-auth-010-corpus-augment.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Example = {
  id: string;
  variant?: string;
  instruction: string;
  input: unknown;
};

const examples = JSON.parse(
  readFileSync(join(__dirname, '../archlora/corpus/corpus-auth-010-pairs.json'), 'utf8'),
) as Example[];

/** Expected IR-LINT-MISSING-AUTH-010 nodeIds (after augment). IR-LINT-MULTIPLE-HTTP-ENTRIES-009 is asserted separately. */
const EXPECTED_010: Record<string, string[]> = {
  'auth-001': ['api-gateway'],
  'auth-002': ['public-api'],
  'auth-003': ['web-bff'],
  'auth-004': ['mobile-gateway', 'web-gateway'],
  'auth-005': ['grpc-gateway'],
  'auth-006': [],
  'auth-007': [],
  'auth-008': [],
  'auth-009': [],
  'auth-010': [],
  'auth-011': [],
  'auth-012': [],
  'auth-013': ['payment-gateway'],
  'auth-014': ['graphql-api'],
  'auth-015': [],
  'auth-016': ['admin-gateway'],
  'auth-017': [],
  'auth-018': [],
  'auth-019': [],
  'auth-020': ['checkout-gateway'],
};

const EXPECT_009: Record<string, boolean> = {
  'auth-004': true,
  'auth-016': true,
};

function sortIds(ids: (string | undefined)[]): string[] {
  return [...new Set(ids.filter(Boolean) as string[])].sort();
}

describe('IR-LINT-MISSING-AUTH-010 corpus (20 examples, engine oracle)', () => {
  it('loads exactly 20 examples', () => {
    expect(examples).toHaveLength(20);
  });

  for (const ex of examples) {
    it(`${ex.id}: ${ex.variant ?? ''}`, () => {
      const ir = augmentCorpusGraph(ex.input);
      const findings = validateIrLint(ir);
      const codes = new Set(findings.map((f) => f.code));

      const allowed = new Set(['IR-LINT-MISSING-AUTH-010', 'IR-LINT-MULTIPLE-HTTP-ENTRIES-009']);
      for (const c of codes) {
        expect(allowed.has(c)).toBe(true);
      }

      const f010 = findings.filter((f) => f.code === 'IR-LINT-MISSING-AUTH-010');
      expect(sortIds(f010.map((f) => f.nodeId))).toEqual(
        (EXPECTED_010[ex.id] ?? []).slice().sort(),
      );

      expect(codes.has('IR-LINT-MULTIPLE-HTTP-ENTRIES-009')).toBe(EXPECT_009[ex.id] === true);

      if (f010.length) {
        for (const f of f010) {
          expect(f.message).toMatch(/^HTTP entry node "/);
          expect(f.fixHint ?? '').toMatch(/authRequired: false/);
        }
      }
    });
  }
});
