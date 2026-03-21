import { describe, it, expect } from 'vitest';
import {
  normalizeNodeSlot,
  normalizeEdgeSlot,
  materializeNormalizedGraph,
} from './ir-normalize.js';

describe('ir-normalize', () => {
  it('normalizeNodeSlot maps type/kind to lowercase type', () => {
    expect(normalizeNodeSlot({ id: 'a', type: 'HTTP', config: { x: 1 } })).toEqual({
      id: 'a',
      type: 'http',
      name: '',
      config: { x: 1 },
      schema: {},
    });
    expect(normalizeNodeSlot({ id: 'b', kind: 'Db', name: 'Main' })).toMatchObject({
      id: 'b',
      type: 'db',
      name: 'Main',
    });
  });

  it('normalizeNodeSlot returns empty shape for non-object', () => {
    expect(normalizeNodeSlot(null)).toEqual({
      id: '',
      type: '',
      name: '',
      config: {},
      schema: {},
    });
  });

  it('normalizeEdgeSlot maps source/target to from/to', () => {
    expect(
      normalizeEdgeSlot({ source: ' a ', target: ' b ', id: 'e1', config: { retry: true } }),
    ).toEqual({
      id: 'e1',
      from: 'a',
      to: 'b',
      config: { retry: true },
    });
  });

  it('materializeNormalizedGraph coerces metadata and flags malformed edges', () => {
    const { normalized, edgesInputWasMalformed } = materializeNormalizedGraph({
      metadata: { version: 1 },
      nodes: [{ id: 'n1', type: 'http', config: { url: '/' } }],
      edges: 'not-array',
    } as unknown as Record<string, unknown>);
    expect(edgesInputWasMalformed).toBe(true);
    expect(normalized.metadata).toEqual({ version: 1 });
    expect(normalized.nodes).toHaveLength(1);
    expect(normalized.edges).toEqual([]);
  });

  it('materializeNormalizedGraph maps edges array', () => {
    const { normalized, edgesInputWasMalformed } = materializeNormalizedGraph({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    });
    expect(edgesInputWasMalformed).toBe(false);
    expect(normalized.edges[0]).toMatchObject({ from: 'a', to: 'b' });
  });
});
