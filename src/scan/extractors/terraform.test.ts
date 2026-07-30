import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase } from '../scan.js';
import { refineAwsDbEngine, refineGoogleSqlEngine, relationForTargetType } from './terraform-resource-map.js';
import { canonicalIrToJsonString } from '../../yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from '../../ir-structural.js';
import { readProvenance, elementConfidence } from '../provenance.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/scan/', import.meta.url));

function graphOf(ir: Record<string, unknown>) {
  return ir.graph as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
}

describe('terraform-resource-map helpers', () => {
  it('refines aws_db_instance engine to a specific IR type', () => {
    expect(refineAwsDbEngine('postgres')).toBe('postgres');
    expect(refineAwsDbEngine('mysql')).toBe('mysql');
    expect(refineAwsDbEngine('mariadb')).toBe('mysql');
    expect(refineAwsDbEngine(undefined)).toBe('postgres');
  });

  it('refines google_sql_database_instance version to a specific IR type', () => {
    expect(refineGoogleSqlEngine('POSTGRES_15')).toBe('postgres');
    expect(refineGoogleSqlEngine('MYSQL_8_0')).toBe('mysql');
  });

  it('buckets edge relation by target type', () => {
    expect(relationForTargetType('postgres').relation).toBe('dbConnection');
    expect(relationForTargetType('queue').relation).toBe('queue');
    expect(relationForTargetType('service').relation).toBe('serviceCall');
  });
});

describe('scanCodebase — terraform extractor', () => {
  it('maps recognized resources to nodes and skips unrecognized ones', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}terraform-basic`, extractors: ['terraform'] });
    const g = graphOf(result.ir);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['postgres_orders_db', 'queue_orders_queue', 'service_api']);
    expect(ids).not.toContain('app_sg'); // aws_security_group is unrecognized — quiet skip
  });

  it('refines aws_db_instance to postgres via its engine argument', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}terraform-basic`, extractors: ['terraform'] });
    const db = graphOf(result.ir).nodes.find((n) => n.id === 'postgres_orders_db')!;
    expect(db.type).toBe('postgres');
  });

  it('finds cross-resource references as edges (dbConnection, queue)', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}terraform-basic`, extractors: ['terraform'] });
    const g = graphOf(result.ir);
    expect(g.edges).toHaveLength(2);
    expect(g.edges.some((e) => e.from === 'service_api' && e.to === 'postgres_orders_db' && (e.metadata as Record<string, unknown>).relation === 'dbConnection')).toBe(true);
    expect(g.edges.some((e) => e.from === 'service_api' && e.to === 'queue_orders_queue' && (e.metadata as Record<string, unknown>).relation === 'queue')).toBe(true);
  });

  it('every node/edge carries medium-confidence provenance with the real resource-block line', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}terraform-basic`, extractors: ['terraform'] });
    const g = graphOf(result.ir);
    for (const el of [...g.nodes, ...g.edges]) {
      expect(elementConfidence(el)).toBe('medium');
      const prov = readProvenance(el)[0]!;
      expect(prov.extractor).toBe('terraform');
      expect(prov.inferred_from).toMatch(/^main\.tf:\d+$/);
    }
    // `resource "aws_db_instance" "orders_db"` opens on line 6 of the fixture.
    const db = g.nodes.find((n) => n.id === 'postgres_orders_db')!;
    expect(readProvenance(db)[0]!.inferred_from).toBe('main.tf:6');
  });

  it('matches the committed golden byte-for-byte and is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}terraform-basic` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}terraform-basic` });
    const golden = readFileSync(`${FIXTURE_ROOT}terraform-basic.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(a.ir)).toBe(golden);
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });

  it('produces structurally valid IR', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}terraform-basic` });
    expect(hasIrStructuralErrors(validateIrStructural(result.ir))).toBe(false);
  });
});
