import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase, registeredExtractorNames } from './scan.js';
import { canonicalIrToJsonString } from '../yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from '../ir-structural.js';
import { readProvenance } from './provenance.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/scan/', import.meta.url));

function graphOf(ir: Record<string, unknown>) {
  const g = ir.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[]; metadata: Record<string, unknown> };
  return g;
}

describe('scanCodebase — compose extractor', () => {
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
