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
  it('returns structural findings when IR root is invalid (not silent [])', () => {
    const f = validateIrLint(null);
    expect(f.some((x) => x.code === 'IR-STRUCT-INVALID_ROOT')).toBe(true);
  });

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

  it('does not flag health when /ping present', () => {
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'http', config: { url: '/internal/ping', method: 'GET' } }],
        edges: [],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-NO-HEALTHCHECK-003')).toBe(false);
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

  it('IR-LINT-SYNC-CHAIN-001 skips edges marked async (metadata.protocol)', () => {
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
          { from: 'b', to: 'c', metadata: { protocol: 'async' } },
          { from: 'c', to: 'd' },
        ],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-SYNC-CHAIN-001')).toBe(false);
  });

  it('ecommerce-with-warnings.json is structurally valid and triggers baseline IR-LINT categories', () => {
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

  it('IR-LINT-ISOLATED-NODE-005 when a node has no edges but graph has other edges', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'a', type: 'http', name: 'A', config: { url: '/a', method: 'GET' } },
          { id: 'b', type: 'service', name: 'B' },
          { id: 'orphan', type: 'service', name: 'Orphan' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-ISOLATED-NODE-005' && x.nodeId === 'orphan')).toBe(true);
  });

  it('IR-LINT-DUPLICATE-EDGE-006', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'x', type: 'http', name: 'X', config: { url: '/x', method: 'GET' } },
          { id: 'y', type: 'service', name: 'Y' },
        ],
        edges: [
          { from: 'x', to: 'y' },
          { from: 'x', to: 'y' },
        ],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-DUPLICATE-EDGE-006')).toBe(true);
  });

  it('IR-LINT-HTTP-MISSING-NAME-007', () => {
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'http', config: { url: '/x', method: 'GET' } }],
        edges: [],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-HTTP-MISSING-NAME-007')).toBe(true);
  });

  it('IR-LINT-DATASTORE-NO-INCOMING-008', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', name: 'API', config: { url: '/x', method: 'GET' } },
          { id: 'db', type: 'postgres', name: 'DB' },
        ],
        edges: [],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-DATASTORE-NO-INCOMING-008')).toBe(true);
  });

  it('IR-LINT-MULTIPLE-HTTP-ENTRIES-009', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'a', type: 'http', name: 'A', config: { url: '/a', method: 'GET' } },
          { id: 'b', type: 'http', name: 'B', config: { url: '/b', method: 'GET' } },
        ],
        edges: [],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-MULTIPLE-HTTP-ENTRIES-009')).toBe(true);
  });

  // IR-LINT-MISSING-AUTH-010
  it('IR-LINT-MISSING-AUTH-010 fires on HTTP entry with no auth coverage', () => {
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'http', name: 'API', config: { url: '/orders', method: 'GET' } }],
        edges: [],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-MISSING-AUTH-010' && x.nodeId === 'api')).toBe(true);
  });

  it('IR-LINT-MISSING-AUTH-010 clears when outgoing neighbour is auth-like', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', name: 'API', config: { url: '/orders', method: 'GET' } },
          { id: 'mw', type: 'auth', name: 'Auth middleware' },
          { id: 'svc', type: 'service', name: 'Orders service' },
        ],
        edges: [
          { from: 'api', to: 'mw' },
          { from: 'mw', to: 'svc' },
        ],
      },
    };
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-MISSING-AUTH-010')).toBe(false);
  });

  it('IR-LINT-MISSING-AUTH-010 clears when auth-like node points to the HTTP entry', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'gw', type: 'oauth', name: 'OAuth gateway' },
          { id: 'api', type: 'http', name: 'API', config: { url: '/orders', method: 'GET' } },
        ],
        edges: [{ from: 'gw', to: 'api' }],
      },
    };
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-MISSING-AUTH-010')).toBe(false);
  });

  it('IR-LINT-MISSING-AUTH-010 clears when config carries an auth key', () => {
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'http', name: 'API', config: { url: '/orders', method: 'GET', auth: 'bearer' } }],
        edges: [],
      },
    };
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-MISSING-AUTH-010')).toBe(false);
  });

  it('IR-LINT-MISSING-AUTH-010 clears when config.authRequired is false (explicit public opt-out)', () => {
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'http', name: 'Health', config: { url: '/health', method: 'GET', authRequired: false } }],
        edges: [],
      },
    };
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-MISSING-AUTH-010')).toBe(false);
  });

  it('IR-LINT-MISSING-AUTH-010 does not fire on non-entry HTTP nodes', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'gw', type: 'gateway', name: 'Gateway', config: { auth: 'bearer' } },
          { id: 'api', type: 'http', name: 'API', config: { url: '/orders', method: 'GET' } },
        ],
        edges: [{ from: 'gw', to: 'api' }],
      },
    };
    // api has an incoming edge so it is not an entry node — rule must not fire for it
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-MISSING-AUTH-010' && x.nodeId === 'api')).toBe(false);
  });

  // IR-LINT-DEAD-NODE-011
  it('IR-LINT-DEAD-NODE-011 fires on non-sink node with incoming edges but no outgoing', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', name: 'API', config: { url: '/x', method: 'GET', auth: 'bearer' } },
          { id: 'svc', type: 'service', name: 'Dead service' },
        ],
        edges: [{ from: 'api', to: 'svc' }],
      },
    };
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-DEAD-NODE-011' && x.nodeId === 'svc')).toBe(true);
  });

  it('IR-LINT-DEAD-NODE-011 does not fire on datastore sink nodes', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', name: 'API', config: { url: '/x', method: 'GET', auth: 'bearer' } },
          { id: 'svc', type: 'service', name: 'Service' },
          { id: 'db', type: 'postgres', name: 'DB' },
        ],
        edges: [
          { from: 'api', to: 'svc' },
          { from: 'svc', to: 'db' },
        ],
      },
    };
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-DEAD-NODE-011')).toBe(false);
  });

  it('IR-LINT-DEAD-NODE-011 does not fire on queue sink nodes', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', name: 'API', config: { url: '/x', method: 'GET', auth: 'bearer' } },
          { id: 'q', type: 'sqs', name: 'Queue' },
        ],
        edges: [{ from: 'api', to: 'q' }],
      },
    };
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-DEAD-NODE-011')).toBe(false);
  });

  it('IR-LINT-DEAD-NODE-011 does not fire on truly isolated nodes (caught by ISOLATED-NODE-005)', () => {
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'http', name: 'API', config: { url: '/x', method: 'GET', auth: 'bearer' } },
          { id: 'svc', type: 'service', name: 'Svc' },
          { id: 'orphan', type: 'service', name: 'Orphan' },
        ],
        edges: [{ from: 'api', to: 'svc' }],
      },
    };
    expect(validateIrLint(ir).some((x) => x.code === 'IR-LINT-DEAD-NODE-011' && x.nodeId === 'orphan')).toBe(false);
  });

  it('demo-direct-db-violation.json flags IR-LINT-DIRECT-DB-ACCESS-002 (README GIF)', () => {
    const ir = readFixture('demo-direct-db-violation.json');
    const structural = validateIrStructural(ir);
    expect(structural.filter((x) => x.severity === 'error')).toHaveLength(0);
    const f = validateIrLint(ir);
    expect(f.some((x) => x.code === 'IR-LINT-DIRECT-DB-ACCESS-002')).toBe(true);
  });

  it('demo-direct-db-layered.json passes architecture lint (README GIF)', () => {
    const ir = readFixture('demo-direct-db-layered.json');
    const structural = validateIrStructural(ir);
    expect(structural.filter((x) => x.severity === 'error')).toHaveLength(0);
    expect(validateIrLint(ir)).toHaveLength(0);
  });
});
