import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { irToWorkflowDoc, layoutPositions, layoutTier, LAYOUT } from './workflow-doc.js';
import { scanCodebase } from './scan.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/scan/', import.meta.url));

function loadFixtureIr(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${FIXTURE_ROOT}${name}`, 'utf8'));
}

describe('irToWorkflowDoc — field mapping', () => {
  const doc = irToWorkflowDoc(loadFixtureIr('compose-basic.expected-ir.json'));

  it('maps graph metadata (name, draft status, scan provenance)', () => {
    expect(doc.metadata.name).toBe('compose-basic');
    expect(doc.metadata.status).toBe('draft');
    expect((doc.metadata.provenance as Record<string, unknown>).source).toBe('scan');
  });

  it('maps nodes with id/type preserved and name → label', () => {
    const pg = doc.nodes.find((n) => n.id === 'postgres');
    expect(pg).toBeDefined();
    expect(pg!.type).toBe('postgres');
    expect(pg!.label).toBe('postgres');
    const gw = doc.nodes.find((n) => n.id === 'gateway_api');
    expect(gw!.label).toBe('api');
  });

  it('preserves config.provenance citations on every node', () => {
    for (const node of doc.nodes) {
      const prov = (node.config as Record<string, unknown>).provenance as {
        inferred_from: string;
      }[];
      expect(Array.isArray(prov)).toBe(true);
      expect(prov.length).toBeGreaterThan(0);
      expect(prov[0]!.inferred_from).toMatch(/^docker-compose\.yml:\d+$/);
    }
  });

  it('maps edges from/to → source/target with relation and transport', () => {
    // The compose fixture emits two edges out of the api gateway, with
    // different relations: a DB connection string and a depends_on link.
    const toDb = doc.edges.find((e) => e.source === 'gateway_api' && e.target === 'postgres');
    expect(toDb).toBeDefined();
    expect(toDb!.relationshipType).toBe('connectionUrl');
    expect(toDb!.label).toBe('connectionUrl');
    expect(toDb!.transport).toBe('sync');

    const toCache = doc.edges.find((e) => e.source === 'gateway_api' && e.target === 'cache_redis');
    expect(toCache).toBeDefined();
    expect(toCache!.relationshipType).toBe('depends_on');
    expect(toCache!.protocol).toBe('tcp');
  });

  it('every node has a position', () => {
    for (const node of doc.nodes) {
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
    }
  });
});

describe('irToWorkflowDoc — robustness', () => {
  it('accepts a bare graph object (no `graph` wrapper)', () => {
    const doc = irToWorkflowDoc({
      metadata: { name: 'bare' },
      nodes: [{ id: 'a', type: 'service' }],
      edges: [],
    });
    expect(doc.metadata.name).toBe('bare');
    expect(doc.nodes).toHaveLength(1);
  });

  it('drops edges whose endpoints are missing from the node set', () => {
    const doc = irToWorkflowDoc({
      graph: {
        metadata: { name: 'dangling' },
        nodes: [{ id: 'a', type: 'service' }],
        edges: [
          { id: 'ok-none', from: 'a', to: 'ghost' },
          { id: 'ok-self', from: 'a', to: 'a' },
          { from: 'missing', to: 'a' },
        ],
      },
    });
    expect(doc.edges.map((e) => e.id)).toEqual(['ok-self']);
  });

  it('skips malformed and duplicate nodes without throwing', () => {
    const doc = irToWorkflowDoc({
      graph: {
        metadata: {},
        nodes: [{ id: 'a', type: 'service' }, { id: 'a', type: 'service' }, { type: 'no-id' }, null, 'junk'],
        edges: 'not-an-array',
      },
    });
    expect(doc.nodes).toHaveLength(1);
    expect(doc.edges).toHaveLength(0);
    expect(doc.metadata.name).toBe('Scanned architecture');
  });

  it('maps async edge metadata to transport "async"', () => {
    const doc = irToWorkflowDoc({
      graph: {
        metadata: { name: 'x' },
        nodes: [
          { id: 'svc', type: 'service' },
          { id: 'q', type: 'kafka' },
        ],
        edges: [{ id: 'e1', from: 'svc', to: 'q', metadata: { relation: 'publishes', async: true } }],
      },
    });
    expect(doc.edges[0]!.transport).toBe('async');
  });
});

describe('layout — deterministic tiers', () => {
  it('assigns tiers entry → compute → messaging → data', () => {
    expect(layoutTier('gateway')).toBe(0);
    expect(layoutTier('api')).toBe(0);
    expect(layoutTier('service')).toBe(1);
    expect(layoutTier('worker')).toBe(1);
    expect(layoutTier('kafka')).toBe(2);
    expect(layoutTier('queue')).toBe(2);
    expect(layoutTier('postgres')).toBe(3);
    expect(layoutTier('cache')).toBe(3);
  });

  it('places tiers left-to-right and wraps long tiers into sub-columns', () => {
    const nodes = [
      { id: 'gw', type: 'gateway' },
      ...Array.from({ length: LAYOUT.maxRows + 1 }, (_, i) => ({
        id: `svc_${String(i).padStart(2, '0')}`,
        type: 'service',
      })),
      { id: 'db', type: 'postgres' },
    ];
    const pos = layoutPositions(nodes);

    const gwX = pos.get('gw')!.x;
    const firstSvcX = pos.get('svc_00')!.x;
    const wrappedSvcX = pos.get(`svc_${LAYOUT.maxRows}`)!.x;
    const dbX = pos.get('db')!.x;

    expect(firstSvcX).toBeGreaterThan(gwX);
    // Row maxRows+1 wraps into a second sub-column of the same tier.
    expect(wrappedSvcX).toBe(firstSvcX + LAYOUT.columnWidth);
    expect(pos.get(`svc_${LAYOUT.maxRows}`)!.y).toBe(LAYOUT.originY);
    // The data tier starts after BOTH service sub-columns.
    expect(dbX).toBeGreaterThan(wrappedSvcX);
  });

  it('is byte-deterministic regardless of input order', () => {
    const forward = [
      { id: 'a', type: 'service' },
      { id: 'b', type: 'postgres' },
      { id: 'c', type: 'gateway' },
    ];
    const reversed = [...forward].reverse();
    expect(layoutPositions(forward)).toEqual(layoutPositions(reversed));
  });
});

describe('irToWorkflowDoc — end-to-end against live scan output', () => {
  it('converts a real scan of the compose fixture deterministically', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-basic` });
    const doc1 = irToWorkflowDoc(result.ir);
    const doc2 = irToWorkflowDoc(result.ir);
    expect(JSON.stringify(doc1)).toBe(JSON.stringify(doc2));
    expect(doc1.nodes.length).toBeGreaterThan(0);
    expect(doc1.edges.length).toBeGreaterThan(0);
    // Cited provenance survives the full scan → doc pipeline.
    const withProv = doc1.nodes.filter(
      (n) => Array.isArray((n.config as Record<string, unknown> | undefined)?.provenance),
    );
    expect(withProv.length).toBe(doc1.nodes.length);
  });
});
