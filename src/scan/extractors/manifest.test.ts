import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase } from '../scan.js';
import { parseRequirementLine } from './manifest.js';
import { NPM_LIB_MAP, PIP_LIB_MAP } from './lib-map.js';
import { canonicalIrToJsonString } from '../../yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from '../../ir-structural.js';
import { readProvenance, elementConfidence } from '../provenance.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/scan/', import.meta.url));

function graphOf(ir: Record<string, unknown>) {
  return ir.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
}

describe('parseRequirementLine', () => {
  it('extracts and normalizes package names, ignoring versions/extras/options', () => {
    expect(parseRequirementLine('psycopg2-binary==2.9.9')).toBe('psycopg2-binary');
    expect(parseRequirementLine('Redis>=5.0  # cache')).toBe('redis');
    expect(parseRequirementLine('uvicorn[standard]==0.30')).toBe('uvicorn');
    expect(parseRequirementLine('  # a comment')).toBeNull();
    expect(parseRequirementLine('-r base.txt')).toBeNull();
    expect(parseRequirementLine('')).toBeNull();
  });
});

describe('lib maps', () => {
  it('map driver libs to canonical infra targets', () => {
    expect(NPM_LIB_MAP.pg!.type).toBe('postgres');
    expect(NPM_LIB_MAP.ioredis!.type).toBe('cache');
    expect(PIP_LIB_MAP.asyncpg!.type).toBe('postgres');
  });
});

describe('scanCodebase — manifest extractor', () => {
  it('emits a component + infra nodes with low-confidence provenance', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-basic`, extractors: ['manifest'] });
    const g = graphOf(result.ir);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['cache_redis', 'postgres', 'service_orders_service']);

    for (const el of [...g.nodes, ...g.edges]) {
      expect(elementConfidence(el)).toBe('low');
      expect(readProvenance(el)[0]!.extractor).toBe('manifest');
    }
    // pg is on line 6 of the fixture package.json.
    const pg = g.nodes.find((n) => n.id === 'postgres')!;
    expect(readProvenance(pg)[0]!.inferred_from).toBe('package.json:6');

    // express (not a driver lib) produces no node/edge.
    expect(ids).not.toContain('service_express');
  });

  it('matches the committed golden byte-for-byte', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-basic` });
    const golden = readFileSync(`${FIXTURE_ROOT}manifest-basic.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(result.ir)).toBe(golden);
  });
});

describe('scanCodebase — cross-extractor infra merge', () => {
  it('unions compose (high) and manifest (low) provenance on shared infra ids', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-and-manifest` });
    const g = graphOf(result.ir);

    for (const id of ['postgres', 'cache_redis']) {
      const node = g.nodes.find((n) => n.id === id)!;
      expect(node, `expected merged node ${id}`).toBeDefined();
      const extractors = readProvenance(node).map((p) => p.extractor).sort();
      expect(extractors).toEqual(['compose', 'manifest']);
      // Highest confidence (compose) wins the merged confidence.
      expect(elementConfidence(node)).toBe('high');
    }
  });

  it('does NOT merge the app node across extractors (known type-mismatch limitation)', async () => {
    // compose infers `gateway_api` (ports) while manifest emits `service_api`.
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-and-manifest` });
    const ids = graphOf(result.ir).nodes.map((n) => n.id);
    expect(ids).toContain('gateway_api');
    expect(ids).toContain('service_api');
  });

  it('produces structurally valid, deterministic IR', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}compose-and-manifest` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}compose-and-manifest` });
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
    expect(hasIrStructuralErrors(validateIrStructural(a.ir))).toBe(false);
  });
});
