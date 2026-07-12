import { describe, it, expect } from 'vitest';
import { mergeDraftFragments } from './merge-draft.js';
import type { PartialIR } from './types.js';
import { readProvenance, elementConfidence } from './provenance.js';

function node(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'service', name: id, ...extra };
}

function prov(extractor: string, from: string, confidence: 'high' | 'medium' | 'low') {
  return { inferred_from: from, confidence, extractor };
}

describe('mergeDraftFragments', () => {
  it('keeps the highest-confidence body and unions provenance on id collision', () => {
    const a: PartialIR = {
      extractor: 'code',
      nodes: [node('postgres', { config: { note: 'from-code', provenance: [prov('code', 'src/db.ts:3', 'low')] } })],
      edges: [],
      warnings: [],
    };
    const b: PartialIR = {
      extractor: 'compose',
      nodes: [node('postgres', { config: { note: 'from-compose', provenance: [prov('compose', 'docker-compose.yml:5', 'high')] } })],
      edges: [],
      warnings: [],
    };

    const { nodes } = mergeDraftFragments([a, b], { priority: ['compose', 'code'] });
    expect(nodes).toHaveLength(1);
    const merged = nodes[0]!;
    // High-confidence (compose) body wins.
    expect((merged.config as Record<string, unknown>).note).toBe('from-compose');
    expect(elementConfidence(merged)).toBe('high');
    // Both provenance records survive, deduped + sorted.
    const p = readProvenance(merged);
    expect(p.map((x) => x.extractor).sort()).toEqual(['code', 'compose']);
  });

  it('breaks confidence ties by extractor priority order', () => {
    const first: PartialIR = {
      extractor: 'code',
      nodes: [node('svc', { config: { note: 'code', provenance: [prov('code', 'a:1', 'medium')] } })],
      edges: [],
      warnings: [],
    };
    const second: PartialIR = {
      extractor: 'compose',
      nodes: [node('svc', { config: { note: 'compose', provenance: [prov('compose', 'b:1', 'medium')] } })],
      edges: [],
      warnings: [],
    };
    const { nodes } = mergeDraftFragments([first, second], { priority: ['compose', 'code'] });
    expect((nodes[0]!.config as Record<string, unknown>).note).toBe('compose');
  });

  it('drops edges whose endpoints did not survive and warns', () => {
    const p: PartialIR = {
      extractor: 'compose',
      nodes: [node('api')],
      edges: [
        { id: 'e0', from: 'api', to: 'ghost', metadata: { relation: 'depends_on' }, config: { provenance: [prov('compose', 'c:1', 'high')] } },
      ],
      warnings: [],
    };
    const { edges, warnings } = mergeDraftFragments([p], { priority: ['compose'] });
    expect(edges).toHaveLength(0);
    expect(warnings.some((w) => w.includes('ghost'))).toBe(true);
  });

  it('is order-independent for output (deterministic sort by id)', () => {
    const p: PartialIR = {
      extractor: 'compose',
      nodes: [node('zebra'), node('alpha'), node('mid')],
      edges: [],
      warnings: [],
    };
    const { nodes } = mergeDraftFragments([p], { priority: ['compose'] });
    expect(nodes.map((n) => n.id)).toEqual(['alpha', 'mid', 'zebra']);
  });
});
