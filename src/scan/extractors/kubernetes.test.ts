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

  it('survives a containers mapping that should have been a list', async () => {
    // argo-cd ships such a manifest in testdata. Iterating the mapping threw a
    // TypeError out of the extractor, so one malformed file anywhere in a repo
    // produced no scan at all.
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}k8s-malformed-containers`,
      extractors: ['kubernetes'],
    });
    const g = graphOf(result.ir);

    // The valid document in the same file is still extracted.
    expect(g.nodes.map((n) => n.id)).toContain('service_healthy_api');
    // The malformed workload still becomes a node: it is a real declared
    // DaemonSet, and only its container list is unreadable. We drop what we
    // cannot parse, not the component it belongs to.
    expect(g.nodes.map((n) => n.id)).toContain('service_rdma_device_plugin');
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

describe('scanCodebase — kubernetes envFrom namespace isolation', () => {
  it('resolves same-named ConfigMaps and Services only inside the workload namespace', async () => {
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}k8s-envfrom-namespaces`,
      extractors: ['kubernetes'],
    });
    const edges = graphOf(result.ir).edges.filter((edge) =>
      (edge.metadata as Record<string, unknown>)?.env === 'DATABASE_URL',
    );
    expect(edges).toHaveLength(2);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'service_app_a', to: 'postgres_db_a' }),
      expect.objectContaining({ from: 'service_app_b', to: 'postgres_db_b' }),
    ]));
    expect(edges.some((edge) => edge.from === 'service_app_a' && edge.to === 'postgres_db_b')).toBe(false);
    for (const edge of edges) expect(readProvenance(edge)).toHaveLength(2);
  });
});

describe('scanCodebase — Kustomize namespace inheritance', () => {
  it('applies the nearest Kustomization namespace before resolving ConfigMaps and DNS', async () => {
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}k8s-kustomize-namespace`,
      extractors: ['kubernetes'],
    });
    const edge = graphOf(result.ir).edges.find((candidate) =>
      candidate.from === 'service_app' && candidate.to === 'service_backend',
    );
    expect(edge).toBeDefined();
    expect((edge!.metadata as Record<string, unknown>).env).toBe('BACKEND_URL');
    expect(readProvenance(edge!)).toHaveLength(2);
  });
});

describe('scanCodebase — kubernetes extractor, service-address env vars', () => {
  it('links services wired by *_SERVICE_ADDR host:port env values', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-service-addr`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    const edge = g.edges.find(
      (e) => String(e.from).includes('frontend') && String(e.to).includes('cartservice'),
    );
    expect(edge).toBeDefined();
    // App-to-app, so a call rather than a datastore connection.
    expect((edge!.metadata as Record<string, unknown>).relation).toBe('serviceCall');
  });

  it('names the relation from what the target actually is', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-service-addr`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    const toCache = g.edges.find((e) => String(e.to).includes('redis'));
    expect(toCache).toBeDefined();
    expect((toCache!.metadata as Record<string, unknown>).relation).toBe('connectionUrl');
  });

  it('does not invent an edge from an incidental value that happens to name a workload', async () => {
    // `CACHE_TYPE: redis` names the redis workload but carries no port and no
    // address-shaped key, so it must not be read as a reference to it.
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-service-addr`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    const fromFrontendToRedis = g.edges.filter(
      (e) => String(e.from).includes('frontend') && String(e.to).includes('redis'),
    );
    expect(fromFrontendToRedis).toHaveLength(0);
  });

  it('leaves the graph connected — no isolated workloads in a fully wired fixture', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-service-addr`, extractors: ['kubernetes'] });
    const g = graphOf(result.ir);
    const touched = new Set(g.edges.flatMap((e) => [String(e.from), String(e.to)]));
    for (const n of g.nodes) expect(touched.has(String(n.id))).toBe(true);
  });

  it('is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-service-addr` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-service-addr` });
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });
});

describe('scanCodebase — kubernetes extractor, container-arg wiring', () => {
  const scan = () => scanCodebase({ from: `${FIXTURE_ROOT}k8s-arg-wiring`, extractors: ['kubernetes'] });

  it('links a service named in a `--flag=url` container arg', async () => {
    const g = graphOf((await scan()).ir);
    const edge = g.edges.find(
      (e) => String(e.from).includes('frontend') && String(e.to).includes('backend'),
    );
    expect(edge).toBeDefined();
    expect((edge!.metadata as Record<string, unknown>).relation).toBe('serviceCall');
  });

  it('links the two-token `--flag` `url` spelling as well', async () => {
    const g = graphOf((await scan()).ir);
    const edge = g.edges.find(
      (e) => String(e.from).includes('backend') && String(e.to).includes('cache'),
    );
    expect(edge).toBeDefined();
    // The target is a cache, so a connection rather than a call.
    expect((edge!.metadata as Record<string, unknown>).relation).toBe('connectionUrl');
  });

  it('does not invent a component from an arg naming a host outside the scan', async () => {
    const g = graphOf((await scan()).ir);
    expect(g.nodes.map((n) => String(n.id))).not.toContain(
      expect.stringContaining('not_in_this_scan'),
    );
    expect(g.edges.filter((e) => String(e.to).includes('not'))).toHaveLength(0);
  });

  it('ignores scalar args that carry no URL scheme', async () => {
    // `--port=9898` and `--level=info` must produce nothing at all.
    const g = graphOf((await scan()).ir);
    expect(g.edges).toHaveLength(3);
  });

  it('leaves no workload isolated in a fully arg-wired fixture', async () => {
    const g = graphOf((await scan()).ir);
    const touched = new Set(g.edges.flatMap((e) => [String(e.from), String(e.to)]));
    for (const n of g.nodes) expect(touched.has(String(n.id))).toBe(true);
  });

  it('carries high-confidence provenance, and is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-arg-wiring` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}k8s-arg-wiring` });
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
    // Only the kubernetes tier: an unfiltered scan also carries low-confidence
    // edges from the image/manifest tiers, which say nothing about this rule.
    for (const e of graphOf((await scan()).ir).edges) {
      expect(elementConfidence(e)).toBe('high');
      expect(readProvenance(e)[0]!.extractor).toBe('kubernetes');
    }
  });

  it('produces structurally valid IR', async () => {
    expect(hasIrStructuralErrors(validateIrStructural((await scan()).ir))).toBe(false);
  });
});
