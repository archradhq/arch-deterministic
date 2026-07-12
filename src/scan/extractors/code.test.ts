import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase } from '../scan.js';
import { pickArtifact } from './code.js';
import type { DetectedArtifact } from '../../reconstruct/types.js';
import { canonicalIrToJsonString } from '../../yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from '../../ir-structural.js';
import { readProvenance, elementConfidence } from '../provenance.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/scan/', import.meta.url));

function graphOf(ir: Record<string, unknown>) {
  return ir.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
}

const art = (kind: DetectedArtifact['kind'], file: string, line: number): DetectedArtifact => ({
  kind,
  detail: '',
  file,
  line,
});

describe('pickArtifact', () => {
  const artifacts = [
    art('app_entry', 'src/index.ts', 21),
    art('db_connection', 'src/db.ts', 5),
    art('auth_middleware', 'src/auth.ts', 8),
  ];
  it('maps a datastore node to a db_connection artifact', () => {
    expect(pickArtifact({ id: 'postgres_x', type: 'postgres' }, artifacts)?.file).toBe('src/db.ts');
  });
  it('maps an auth node to an auth_middleware artifact', () => {
    expect(pickArtifact({ id: 'auth_x', type: 'auth' }, artifacts)?.file).toBe('src/auth.ts');
  });
  it('maps a gateway node to the app_entry artifact', () => {
    expect(pickArtifact({ id: 'gw', type: 'gateway' }, artifacts)?.file).toBe('src/index.ts');
  });
});

describe('scanCodebase — code extractor', () => {
  it('detects the gateway and datastore with low-confidence, line-precise provenance', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}code-basic`, extractors: ['code'] });
    const g = graphOf(result.ir);

    const gw = g.nodes.find((n) => n.type === 'gateway')!;
    const db = g.nodes.find((n) => n.type === 'postgres')!;
    expect(gw).toBeDefined();
    expect(db).toBeDefined();

    for (const el of [...g.nodes, ...g.edges]) {
      expect(elementConfidence(el)).toBe('low');
      const prov = readProvenance(el)[0]!;
      expect(prov.extractor).toBe('code');
      expect(prov.inferred_from).toMatch(/^src\/index\.ts:\d+$/);
    }
    // The DB connection is on line 5 of the fixture source.
    expect(readProvenance(db)[0]!.inferred_from).toBe('src/index.ts:5');
  });

  it('emits nothing when there is no code signal (no phantom service node)', async () => {
    // openapi-basic has only an OpenAPI spec, no source files.
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}openapi-basic`, extractors: ['code'] });
    expect(graphOf(result.ir).nodes).toHaveLength(0);
  });

  it('matches the committed golden byte-for-byte', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}code-basic` });
    const golden = readFileSync(`${FIXTURE_ROOT}code-basic.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(result.ir)).toBe(golden);
  });

  it('produces structurally valid, deterministic IR', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}code-basic` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}code-basic` });
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
    expect(hasIrStructuralErrors(validateIrStructural(a.ir))).toBe(false);
  });
});
