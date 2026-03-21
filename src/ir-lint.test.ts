import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { validateIrLint } from './ir-lint.js';
import { validateIrStructural } from './ir-structural.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'));

describe('validateIrLint', () => {
  it('flags HTTP → database direct edge', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', config: { url: '/x', method: 'GET' } },
          { id: 'db', type: 'postgres', name: 'DB' },
        ],
        edges: [{ from: 'api', to: 'db' }],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-DIRECT-DB-ACCESS-002')).toBe(true);
  });

  it('flags missing health endpoint when HTTP nodes exist', () => {
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'http', config: { url: '/orders', method: 'GET' } }],
        edges: [],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-NO-HEALTHCHECK-003')).toBe(true);
  });

  it('does not flag health when /health present', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', config: { url: '/api/health', method: 'GET' } },
        ],
        edges: [],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-NO-HEALTHCHECK-003')).toBe(false);
  });

  it('flags high fan-out', () => {
    const nodes = [
      { id: 'hub', type: 'http', config: { url: '/hub', method: 'GET' } },
      ...[1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, type: 'service', name: `S${i}` })),
    ];
    const edges = [1, 2, 3, 4, 5].map((i) => ({ from: 'hub', to: `s${i}` }));
    const f = validateIrLint({ graph: { nodes, edges } });
    expect(f.some((x) => x.code === 'IR-LINT-HIGH-FANOUT-004')).toBe(true);
  });

  it('flags long sync chain from HTTP entry', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'a', type: 'http', config: { url: '/a', method: 'GET' } },
          { id: 'b', type: 'service' },
          { id: 'c', type: 'service' },
          { id: 'd', type: 'service' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'd' },
        ],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-SYNC-CHAIN-001')).toBe(true);
  });

  it('ecommerce-with-warnings.json is structurally valid and triggers all four IR-LINT categories', () => {
    const ir = readFixture('ecommerce-with-warnings.json');
    const structural = validateIrStructural(ir);
    expect(structural.filter((x) => x.severity === 'error')).toHaveLength(0);
    const f = validateIrLint(ir);
    const codes = new Set(f.map((x) => x.code));
    expect(codes.has('IR-LINT-DIRECT-DB-ACCESS-002')).toBe(true);
    expect(codes.has('IR-LINT-HIGH-FANOUT-004')).toBe(true);
    expect(codes.has('IR-LINT-SYNC-CHAIN-001')).toBe(true);
    expect(codes.has('IR-LINT-NO-HEALTHCHECK-003')).toBe(true);
  });
});
