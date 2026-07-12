import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase } from '../scan.js';
import { isOpenApiFile } from './openapi.js';
import { canonicalIrToJsonString } from '../../yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from '../../ir-structural.js';
import { readProvenance } from '../provenance.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/scan/', import.meta.url));

function nodesOf(ir: Record<string, unknown>) {
  return (ir.graph as { nodes: Record<string, unknown>[] }).nodes;
}

describe('isOpenApiFile', () => {
  it('matches openapi/swagger json/yaml, not unrelated files', () => {
    expect(isOpenApiFile('openapi.yaml')).toBe(true);
    expect(isOpenApiFile('api/swagger.json')).toBe(true);
    expect(isOpenApiFile('orders.openapi.yml')).toBe(true);
    expect(isOpenApiFile('package.json')).toBe(false);
    expect(isOpenApiFile('README.md')).toBe(false);
  });
});

describe('scanCodebase — openapi extractor', () => {
  it('emits one http node per operation with medium-confidence provenance', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}openapi-basic` });
    const nodes = nodesOf(result.ir);

    expect(nodes).toHaveLength(3);
    for (const n of nodes) {
      expect(n.type).toBe('http');
      const prov = readProvenance(n);
      expect(prov[0]!.confidence).toBe('medium');
      expect(prov[0]!.extractor).toBe('openapi');
      expect(prov[0]!.inferred_from).toBe('openapi.yaml:1');
    }
  });

  it('preserves the engine route-based ids (no canonical remap)', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}openapi-basic` });
    const ids = nodesOf(result.ir).map((n) => n.id).sort();
    expect(ids).toEqual(['openapi_get_health', 'openapi_get_orders', 'openapi_post_orders']);
  });

  it('matches the committed golden draft IR byte-for-byte', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}openapi-basic` });
    const golden = readFileSync(`${FIXTURE_ROOT}openapi-basic.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(result.ir)).toBe(golden);
  });

  it('produces structurally valid, deterministic IR', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}openapi-basic` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}openapi-basic` });
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
    expect(hasIrStructuralErrors(validateIrStructural(a.ir))).toBe(false);
  });

  it('can be selected in isolation via --extractors', async () => {
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}openapi-basic`,
      extractors: ['openapi'],
    });
    expect(result.extractorsRun).toEqual(['openapi']);
    expect(nodesOf(result.ir)).toHaveLength(3);
  });
});
