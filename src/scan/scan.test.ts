import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase, registeredExtractorNames } from './scan.js';
import { canonicalIrToJsonString } from '../yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from '../ir-structural.js';
import { readProvenance } from './provenance.js';
import { isComposeFile, mergeComposeDocuments } from './extractors/compose.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/scan/', import.meta.url));

describe('Compose file discovery', () => {
  it.each([
    'docker-compose.yml.tmpl',
    'infrastructure/docker-compose.yml.tmpl.traefik',
    'compose.prod.yaml.tmpl',
  ])('recognizes Compose-specific template %s', (path) => {
    expect(isComposeFile(path)).toBe(true);
  });

  it.each([
    'deployment.yml.tmpl',
    'compose-config.yml.tmpl',
    'docker-compose.yml.template',
  ])('does not broaden discovery to unrelated template %s', (path) => {
    expect(isComposeFile(path)).toBe(false);
  });
});

function graphOf(ir: Record<string, unknown>) {
  const g = ir.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[]; metadata: Record<string, unknown> };
  return g;
}

describe('scanCodebase — test-material directories', () => {
  it('skips fixture directories but keeps examples/ and nested tests/', async () => {
    // argo-cd keeps Kubernetes YAML for its unit tests: 47 of its 169 nodes were
    // fixtures like `service_never_ready`, disconnected by design and crowding
    // out the real components.
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}test-dir-exclusion` });
    const names = graphOf(result.ir).nodes.map((n) => n.name as string);

    expect(names).toContain('api');
    // testdata/ at any depth, and a top-level test/ tree, are test material.
    expect(names).not.toContain('fixture-never-ready');
    expect(names).not.toContain('fixture-e2e-harness');
    // examples/ is usually a deployment someone is expected to run, and `tests`
    // is only a test root at the top level — both are kept on purpose.
    expect(names).toContain('example-guestbook');
    expect(names).toContain('nested-tests-service');
  });

  it('offers a production scope without changing the backwards-compatible all scope', async () => {
    const all = await scanCodebase({ from: `${FIXTURE_ROOT}test-dir-exclusion`, scope: 'all' });
    const production = await scanCodebase({ from: `${FIXTURE_ROOT}test-dir-exclusion`, scope: 'production' });
    const allNames = graphOf(all.ir).nodes.map((n) => n.name as string);
    const productionNames = graphOf(production.ir).nodes.map((n) => n.name as string);

    expect(allNames).toContain('example-guestbook');
    expect(allNames).toContain('nested-tests-service');
    expect(allNames).toContain('docs-only-service');
    expect(productionNames).toEqual(['api']);
    expect(production.fileCount).toBeLessThan(all.fileCount);
  });
});

describe('scanCodebase — empty result messaging', () => {
  it('names Helm as the reason instead of claiming there is no architecture', async () => {
    // prometheus-community/helm-charts is 46 charts and 568 manifests, and
    // scanned to zero nodes under a warning that read "no structural signals
    // found" — which sounds like a verdict on the repository rather than on us.
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}helm-only` });
    // A templated name parses as a mapping; stringifying it produced a node
    // literally called "[object Object]".
    expect(graphOf(result.ir).nodes.map((n) => n.name)).not.toContain('[object Object]');
    expect(graphOf(result.ir).nodes).toHaveLength(0);

    const warning = result.warnings.find((w) => w.includes('Helm chart'));
    expect(warning).toBeDefined();
    expect(warning).toContain('1 Helm chart');
    expect(warning).toContain('helm template');
    // The bare, uninformative phrasing is not what a Helm repo gets.
    expect(result.warnings.some((w) => w.includes('no structural signals'))).toBe(false);
  });
});

describe('scanCodebase — compose extractor', () => {
  it('honours reset and override tags while merging Compose documents', () => {
    const merged = mergeComposeDocuments(
      'services:\n  api:\n    image: acme/api\n    profiles: [base]\n    command: [old]\n',
      'services:\n  api:\n    profiles: !reset []\n    command: !override [new]\n',
    );
    expect(merged).toContain('profiles: []');
    expect(merged).toContain('- new');
    expect(merged).not.toContain('- old');
  });

  it('emits a draft IR with canonical node ids and provenance on every element', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-basic` });
    const g = graphOf(result.ir);

    expect(g.metadata.status).toBe('draft');
    expect((g.metadata.provenance as Record<string, unknown>).source).toBe('scan');

    const ids = g.nodes.map((n) => n.id).sort();
    // Canonical ids: gateway_api / gateway_nginx (ports exposed), postgres, cache_redis.
    expect(ids).toContain('postgres');
    expect(ids).toContain('cache_redis');
    expect(ids).toContain('gateway_api');

    // Every node and edge carries provenance.
    for (const el of [...g.nodes, ...g.edges]) {
      const prov = readProvenance(el);
      expect(prov.length).toBeGreaterThan(0);
      expect(prov[0]!.confidence).toBe('high');
      expect(prov[0]!.inferred_from).toMatch(/docker-compose\.yml:\d+$/);
      expect(prov[0]!.extractor).toBe('compose');
    }

    // api → postgres edge exists between canonical ids.
    const apiToPg = g.edges.find((e) => e.from === 'gateway_api' && e.to === 'postgres');
    expect(apiToPg).toBeDefined();
  });

  it('records the real service line number in provenance', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-basic` });
    const g = graphOf(result.ir);
    const pg = g.nodes.find((n) => n.id === 'postgres')!;
    // `postgres:` is on line 13 of the fixture compose file.
    expect(readProvenance(pg)[0]!.inferred_from).toBe('docker-compose.yml:13');
  });

  it('produces structurally valid IR', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-basic` });
    const findings = validateIrStructural(result.ir);
    expect(hasIrStructuralErrors(findings)).toBe(false);
  });

  it('merges the automatic Compose override before extracting topology', async () => {
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}compose-override`,
      extractors: ['compose'],
    });
    const g = graphOf(result.ir);

    expect(g.nodes.map((n) => n.name).sort()).toEqual(['api', 'db', 'mail', 'worker']);
    expect(g.edges.some((e) => String(e.from).includes('api') && String(e.to).includes('db'))).toBe(true);
    expect(g.edges.some((e) => String(e.from).includes('api') && String(e.to).includes('mail'))).toBe(true);

    const api = g.nodes.find((n) => n.name === 'api')!;
    const sources = readProvenance(api).map((p) => p.inferred_from);
    expect(sources.some((source) => source.startsWith('docker-compose.yml:'))).toBe(true);
    expect(sources.some((source) => source.startsWith('docker-compose.override.yml:'))).toBe(true);
  });

  it('does not emit the paired override as a second partial topology', async () => {
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}compose-override`,
      extractors: ['compose'],
    });
    const names = graphOf(result.ir).nodes.map((n) => n.name);
    expect(names.filter((name) => name === 'api')).toHaveLength(1);
    expect(names.filter((name) => name === 'worker')).toHaveLength(1);
  });

  it('merges a named Compose variant only when it references the sibling base', async () => {
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}compose-named-variant`,
      extractors: ['compose'],
    });
    const g = graphOf(result.ir);
    const runner = g.nodes.find((node) => node.name === 'test-runner')!;
    const api = g.nodes.find((node) => node.name === 'api')!;
    expect(g.edges.some((edge) => edge.from === runner.id && edge.to === api.id)).toBe(true);
    expect(readProvenance(runner).map((record) => record.inferred_from))
      .toEqual([expect.stringMatching(/^compose\.tests\.yaml:/)]);
    // No overlap/reference evidence: this remains an independent topology.
    expect(g.nodes.some((node) => node.name === 'unrelated')).toBe(true);
    expect(result.warnings.filter((warning) => warning.includes('api: Unknown image'))).toHaveLength(1);
  });

  it('matches the committed golden draft IR byte-for-byte', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-basic` });
    const golden = readFileSync(`${FIXTURE_ROOT}compose-basic.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(result.ir)).toBe(golden);
  });

  it('is deterministic — two runs produce byte-identical output', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}compose-basic` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}compose-basic` });
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });

  it('rejects unknown extractor names', async () => {
    await expect(
      scanCodebase({ from: `${FIXTURE_ROOT}compose-basic`, extractors: ['bogus'] }),
    ).rejects.toThrow(/unknown extractor/i);
  });

  it('registers the compose extractor', () => {
    expect(registeredExtractorNames()).toContain('compose');
  });
});
