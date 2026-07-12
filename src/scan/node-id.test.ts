import { describe, it, expect } from 'vitest';
import { scanNodeId, scanSlug, canonicalizeIds } from './node-id.js';

describe('scanNodeId', () => {
  it('collapses kind===name to a single token', () => {
    expect(scanNodeId('postgres', 'postgres')).toBe('postgres');
  });

  it('joins kind and name for distinct values', () => {
    expect(scanNodeId('gateway', 'api')).toBe('gateway_api');
    expect(scanNodeId('cache', 'redis')).toBe('cache_redis');
  });

  it('does not double a prefix already present in the name', () => {
    expect(scanNodeId('db', 'db_orders')).toBe('db_orders');
  });

  it('slugs non-alphanumerics deterministically', () => {
    expect(scanSlug('My Service.Name')).toBe('my_service_name');
    expect(scanNodeId('service', 'Order Service')).toBe('service_order_service');
  });

  it('falls back to kind when name is empty', () => {
    expect(scanNodeId('service', '')).toBe('service');
  });
});

describe('canonicalizeIds', () => {
  it('remaps node ids and rewrites edge endpoints', () => {
    const { nodes, edges, idMap } = canonicalizeIds(
      [
        { id: 'api', type: 'gateway', name: 'api' },
        { id: 'db', type: 'postgres', name: 'postgres' },
      ],
      [{ id: 'e0', from: 'api', to: 'db', metadata: { relation: 'depends_on' } }],
    );
    expect(idMap.get('api')).toBe('gateway_api');
    expect(idMap.get('db')).toBe('postgres');
    expect(nodes.map((n) => n.id)).toEqual(['gateway_api', 'postgres']);
    expect(edges[0]!.from).toBe('gateway_api');
    expect(edges[0]!.to).toBe('postgres');
  });

  it('de-collides two distinct nodes that map to the same canonical id', () => {
    const { nodes } = canonicalizeIds(
      [
        { id: 'a', type: 'postgres', name: 'postgres' },
        { id: 'b', type: 'postgres', name: 'postgres' },
      ],
      [],
    );
    expect(nodes.map((n) => n.id)).toEqual(['postgres', 'postgres_2']);
  });
});
