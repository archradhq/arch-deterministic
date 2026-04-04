import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  normalizeIrGraph,
  validateIrStructural,
  hasIrStructuralErrors,
  detectCycles,
} from './ir-structural.js';
import { isHttpEndpointType, isHttpLikeType } from './graphPredicates.js';

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

  it('detects directed cycle with full path in message', () => {
    const ir = readFixture('invalid-cycle.json');
    const f = validateIrStructural(ir);
    const c = f.find((x) => x.code === 'IR-STRUCT-CYCLE');
    expect(c).toBeTruthy();
    // fixture is a → b → c → a
    expect(c!.message).toMatch(/a → b → c → a/);
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

  it('validates HTTP path for endpoint types (http, rest, api, graphql)', () => {
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

  it('gateway node without config.url does not fire IR-STRUCT-HTTP_PATH', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'gw', type: 'gateway', name: 'API Gateway' }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-HTTP_PATH')).toBe(false);
    expect(f.some((x) => x.code === 'IR-STRUCT-HTTP_METHOD')).toBe(false);
  });

  it('grpc node with proto service/method config does not fire HTTP structural errors', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'svc', type: 'grpc', name: 'UserService', config: { service: 'UserService', method: 'GetUser' } }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-HTTP_PATH')).toBe(false);
    expect(f.some((x) => x.code === 'IR-STRUCT-HTTP_METHOD')).toBe(false);
  });

  it('bff node without config.url does not fire HTTP structural errors', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'bff', type: 'bff', name: 'Web BFF' }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-HTTP_PATH')).toBe(false);
  });

  it('graphql node is still validated for url/method (endpoint type)', () => {
    const bad = validateIrStructural({
      graph: {
        nodes: [{ id: 'gql', type: 'graphql', config: { url: 'no-slash', method: 'POST' } }],
        edges: [],
      },
    });
    expect(bad.some((x) => x.code === 'IR-STRUCT-HTTP_PATH')).toBe(true);
    const ok = validateIrStructural({
      graph: {
        nodes: [{ id: 'gql', type: 'graphql', config: { url: '/graphql', method: 'POST' } }],
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

  it('IR-STRUCT-NODE_INVALID_CONFIG when config is an array', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'x', type: 'service', config: ['wrong'] }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-NODE_INVALID_CONFIG' && x.nodeId === 'x')).toBe(true);
    const w = f.find((x) => x.code === 'IR-STRUCT-NODE_INVALID_CONFIG')!;
    expect(w.message).toContain('array');
    expect(w.severity).toBe('warning');
  });

  it('IR-STRUCT-NODE_INVALID_CONFIG when config is null', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'x', type: 'service', config: null }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-NODE_INVALID_CONFIG')).toBe(true);
  });

  it('no IR-STRUCT-NODE_INVALID_CONFIG when config is a plain object', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'x', type: 'service', config: { key: 'val' } }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-NODE_INVALID_CONFIG')).toBe(false);
  });

  it('no IR-STRUCT-NODE_INVALID_CONFIG when config is absent', () => {
    const f = validateIrStructural({
      graph: {
        nodes: [{ id: 'x', type: 'service' }],
        edges: [],
      },
    });
    expect(f.some((x) => x.code === 'IR-STRUCT-NODE_INVALID_CONFIG')).toBe(false);
  });
});

describe('isHttpEndpointType vs isHttpLikeType', () => {
  const endpointTypes = ['http', 'https', 'rest', 'api', 'graphql'];
  const broadOnlyTypes = ['gateway', 'bff', 'grpc'];

  for (const t of endpointTypes) {
    it(`isHttpEndpointType("${t}") is true`, () => expect(isHttpEndpointType(t)).toBe(true));
    it(`isHttpLikeType("${t}") is true`, () => expect(isHttpLikeType(t)).toBe(true));
  }
  for (const t of broadOnlyTypes) {
    it(`isHttpEndpointType("${t}") is false`, () => expect(isHttpEndpointType(t)).toBe(false));
    it(`isHttpLikeType("${t}") is true`, () => expect(isHttpLikeType(t)).toBe(true));
  }
});

describe('detectCycles', () => {
  it('returns null for acyclic graph', () => {
    const adj = new Map([['a', ['b']], ['b', ['c']], ['c', []]]);
    expect(detectCycles(adj)).toBeNull();
  });

  it('returns cycle path for simple cycle', () => {
    const adj = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]);
    const cycle = detectCycles(adj);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe('a');
    expect(cycle).toEqual(['a', 'b', 'c']);
  });

  it('returns cycle path for self-loop', () => {
    const adj = new Map([['a', ['a']]]);
    const cycle = detectCycles(adj);
    expect(cycle).toEqual(['a']);
  });

  it('returns null for empty graph', () => {
    expect(detectCycles(new Map())).toBeNull();
  });
});
