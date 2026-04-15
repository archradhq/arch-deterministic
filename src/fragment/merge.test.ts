import { describe, expect, it } from 'vitest';
import {
  mergeIrFragments,
  FragmentMergeError,
  FragmentMergeConflictError,
  prefixNodeId,
} from './merge.js';

describe('mergeIrFragments (prefix mode)', () => {
  it('merges two fragments with prefixed ids', () => {
    const a = {
      graph: {
        nodes: [{ id: 'n1', type: 'service', kind: 'service', name: 'A', config: {} }],
        edges: [],
      },
    };
    const b = {
      graph: {
        nodes: [{ id: 'n1', type: 'service', kind: 'service', name: 'B', config: {} }],
        edges: [{ from: 'n1', to: 'n1', metadata: { protocol: 'https', async: false } }],
      },
    };
    const m = mergeIrFragments([a, b], { labels: ['a', 'b'], prefixFragments: true });
    const nodes = (m.ir.graph as { nodes: { id: string }[] }).nodes;
    expect(nodes.map((x) => x.id).sort()).toEqual(['a__n1', 'b__n1'].sort());
    expect(m.warnings).toHaveLength(0);
  });
});

describe('mergeIrFragments (union by id)', () => {
  it('dedupes identical node ids across fragments', () => {
    const node = { id: 'svc', type: 'service', kind: 'service', name: 'S', config: { x: 1 } };
    const a = { graph: { nodes: [node], edges: [] } };
    const b = { graph: { nodes: [{ ...node }], edges: [] } };
    const m = mergeIrFragments([a, b], { labels: ['a', 'b'] });
    const nodes = (m.ir.graph as { nodes: unknown[] }).nodes;
    expect(nodes).toHaveLength(1);
  });

  it('throws FragmentMergeConflictError when same id differs', () => {
    const a = {
      graph: {
        nodes: [{ id: 'svc', type: 'service', kind: 'service', name: 'S', config: {} }],
        edges: [],
      },
    };
    const b = {
      graph: {
        nodes: [{ id: 'svc', type: 'database', kind: 'postgres', name: 'S', config: {} }],
        edges: [],
      },
    };
    expect(() => mergeIrFragments([a, b], { labels: ['a', 'b'] })).toThrow(FragmentMergeConflictError);
  });
});

describe('mergeIrFragments (errors)', () => {
  it('throws when fewer than 2 fragments', () => {
    expect(() => mergeIrFragments([{ graph: { nodes: [], edges: [] } }])).toThrow(FragmentMergeError);
  });
});

describe('prefixNodeId', () => {
  it('is stable', () => {
    expect(prefixNodeId('openapi', 'openapi_get_x')).toBe('openapi__openapi_get_x');
  });
});
