import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase } from '../scan.js';
import { documentStartLines } from './kubernetes.js';
import { canonicalIrToJsonString } from '../../yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from '../../ir-structural.js';
import { readProvenance, elementConfidence } from '../provenance.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/scan/', import.meta.url));

function graphOf(ir: Record<string, unknown>) {
  return ir.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
}

describe('documentStartLines', () => {
  it('returns [1] for a single-document file with no separator', () => {
    expect(documentStartLines('apiVersion: v1\nkind: Pod\n')).toEqual([1]);
  });

  it('finds each document start for a normal multi-doc file', () => {
    const text = 'a: 1\n---\nb: 2\n---\nc: 3\n';
    // doc0 at line 1, doc1 at line 3 (after first ---), doc2 at line 5
    expect(documentStartLines(text)).toEqual([1, 3, 5]);
  });

  it('does not miscount a LEADING --- as an extra document boundary', () => {
    // Common style: files often open with a bare --- before any content.
    const text = '---\na: 1\n---\nb: 2\n';
    expect(documentStartLines(text)).toEqual([2, 4]);
  });
});

describe('scanCodebase — kubernetes extractor', () => {
  it('builds workload nodes, resolves Service->workload, and routes Ingress edges', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-basic`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    const ids = g.nodes.map((n) => n.id).sort();

    expect(ids).toEqual(['gateway_api_ingress', 'postgres', 'service_api', 'worker_cleanup_old_runs']);

    // Deployment -> StatefulSet via DATABASE_URL resolving to the postgres Service's DNS name.
    const dbEdge = g.edges.find((e) => e.to === 'postgres');
    expect(dbEdge?.from).toBe('service_api');

    // Ingress -> Deployment via backend.service.name.
    const routeEdge = g.edges.find((e) => e.metadata && (e.metadata as Record<string, unknown>).relation === 'routes');
    expect(routeEdge?.from).toBe('gateway_api_ingress');
    expect(routeEdge?.to).toBe('service_api');
  });

  it('types StatefulSet by image (postgres) and CronJob as worker regardless of image', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-basic`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    expect(g.nodes.find((n) => n.id === 'postgres')?.type).toBe('postgres');
    expect(g.nodes.find((n) => n.id === 'worker_cleanup_old_runs')?.type).toBe('worker');
  });

  it('every node/edge carries high-confidence provenance with the real document line', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-basic`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    for (const el of [...g.nodes, ...g.edges]) {
      expect(elementConfidence(el)).toBe('high');
      const prov = readProvenance(el)[0]!;
      expect(prov.extractor).toBe('kubernetes');
      expect(prov.inferred_from).toMatch(/^k8s\/manifests\.yaml:\d+$/);
    }
    // Deployment "api" (Deployment kind, DATABASE_URL env) is the first document — line 1.
    const api = g.nodes.find((n) => n.id === 'service_api')!;
    expect(readProvenance(api)[0]!.inferred_from).toBe('k8s/manifests.yaml:1');
  });

  it('ignores a bare Service with no matching workload (nothing to anchor an edge to)', async () => {
    // A Service alone (selector matches no workload in this scan) contributes no node.
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-basic`, extractors: ['kubernetes'] });
    const ids = graphOf(result.ir).nodes.map((n) => n.id);
    expect(ids).not.toContain('api'); // the Service itself is never a node, only an alias
    expect(ids).not.toContain('postgres_service');
  });

  it('matches the committed golden byte-for-byte and is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-basic` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-basic` });
    const golden = readFileSync(`${FIXTURE_ROOT}k8s-basic.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(a.ir)).toBe(golden);
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });

  it('produces structurally valid IR', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-basic` });
    expect(hasIrStructuralErrors(validateIrStructural(result.ir))).toBe(false);
  });
});

describe('scanCodebase — kubernetes extractor, resolution across files', () => {
  // k8s-multifile mirrors the most common real-world layout: one resource per
  // file (deployment.yaml, service.yaml, configmap.yaml, ingress.yaml as
  // siblings) — the layout an earlier, per-file version of this extractor
  // would have silently failed to resolve at all.

  it('resolves a Service to its workload across separate files', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-multifile`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    const routeEdge = g.edges.find((e) => (e.metadata as Record<string, unknown>)?.relation === 'routes');
    expect(routeEdge?.from).toBe('gateway_billing_ingress');
    expect(routeEdge?.to).toBe('service_billing_api');
  });

  it('resolves valueFrom.configMapKeyRef against a ConfigMap in a different file', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-multifile`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    const dbEdge = g.edges.find((e) => e.to === 'postgres');
    expect(dbEdge?.from).toBe('service_billing_api');
    expect((dbEdge?.metadata as Record<string, unknown>)?.env).toBe('DATABASE_URL');
  });

  it('warns (does not silently drop) a connection env var wired through a Secret', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-multifile`, extractors: ['kubernetes'] });
    expect(result.warnings.some((w) => w.includes('REDIS_URL') && w.includes('Secret'))).toBe(true);
    // And no edge was fabricated for it — no node/edge references a resolved Redis host.
    const g = graphOf(result.ir);
    expect(g.nodes.some((n) => n.type === 'cache')).toBe(false);
  });

  it('matches the committed golden byte-for-byte and is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-multifile` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-multifile` });
    const golden = readFileSync(`${FIXTURE_ROOT}k8s-multifile.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(a.ir)).toBe(golden);
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });

  it('produces structurally valid IR', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-multifile` });
    expect(hasIrStructuralErrors(validateIrStructural(result.ir))).toBe(false);
  });
});
