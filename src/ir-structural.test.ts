import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  normalizeIrGraph,
  validateIrStructural,
  hasIrStructuralErrors,
} from './ir-structural.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'));

describe('ir-structural', () => {
  it('normalizeIrGraph accepts wrapper and bare graph', () => {
    const w = normalizeIrGraph({ graph: { nodes: [{ id: 'x', type: 'http', config: { url: '/', method: 'GET' } }] } });
    expect('graph' in w && w.graph).toBeTruthy();
    const b = normalizeIrGraph({ nodes: [{ id: 'x', type: 'http', config: { url: '/', method: 'GET' } }] });
    expect('graph' in b && b.graph).toBeTruthy();
  });

  it('normalizeIrGraph rejects invalid root', () => {
    const r = normalizeIrGraph(null);
    expect('findings' in r).toBe(true);
    if ('findings' in r) expect(r.findings[0].code).toBe('IR-STRUCT-INVALID_ROOT');
  });

  it('validateIrStructural passes for minimal-graph fixture shape', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'signup', type: 'http', name: 'Signup', config: { url: '/signup', method: 'POST' } },
        ],
        edges: [],
      },
    };
    const f = validateIrStructural(ir);
    expect(f.filter((x) => x.severity === 'error')).toHaveLength(0);
  });

  it('detects unknown edge endpoint', () => {
    const ir = readFixture('invalid-edge-unknown-node.json');
    const f = validateIrStructural(ir);
    expect(hasIrStructuralErrors(f)).toBe(true);
    expect(f.some((x) => x.code === 'IR-STRUCT-EDGE_UNKNOWN_FROM')).toBe(true);
  });

  it('detects directed cycle', () => {
    const ir = readFixture('invalid-cycle.json');
    const f = validateIrStructural(ir);
    const c = f.find((x) => x.code === 'IR-STRUCT-CYCLE');
    expect(c).toBeTruthy();
    expect(c!.message).toMatch(/node "a"/);
    expect(c!.nodeId).toBe('a');
  });

  it('detects duplicate node id', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [
          { id: 'a', type: 'http', config: { url: '/a', method: 'GET' } },
          { id: 'a', type: 'http', config: { url: '/b', method: 'GET' } },
        ],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-DUP_NODE_ID')).toBe(true);
  });

  it('flags edges that reference a duplicate node id as ambiguous', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [
          { id: 'x', type: 'service' },
          { id: 'x', type: 'service' },
          { id: 'y', type: 'service' },
        ],
        edges: [{ from: 'x', to: 'y' }],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-EDGE_AMBIGUOUS_FROM')).toBe(true);
    expect(f.some((x) => x.code === 'IR-STRUCT-EDGE_UNKNOWN_FROM')).toBe(false);
  });

  it('validates HTTP path for rest-like node types (shared HTTP predicate)', () => {
    const bad = validateIrStructural({
      graph: {
        nodes: [{ id: 'api', type: 'rest', config: { url: 'no-slash', method: 'GET' } }],
        edges: [],
      },
    });
    expect(bad.some((x) => x.code === 'IR-STRUCT-HTTP_PATH')).toBe(true);
    const ok = validateIrStructural({
      graph: {
        nodes: [{ id: 'api', type: 'rest', config: { url: '/r', method: 'GET' } }],
        edges: [],
      },
    });
    expect(ok.filter((x) => x.severity === 'error')).toHaveLength(0);
  });

  it('detects bad HTTP path', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'x', type: 'http', config: { url: 'nope', method: 'GET' } }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-HTTP_PATH')).toBe(true);
  });
});
