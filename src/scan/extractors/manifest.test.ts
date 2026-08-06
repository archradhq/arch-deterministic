import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { scanCodebase } from '../scan.js';
import { parseRequirementLine } from './manifest.js';
import { NPM_LIB_MAP, PIP_LIB_MAP, GO_LIB_MAP, MAVEN_LIB_MAP } from './lib-map.js';
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

  it('does NOT merge compose + manifest app nodes (compose is never tagged scanRoot — it can name multiple real services, so nothing there is safe to assume is "the" root)', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}compose-and-manifest` });
    const ids = graphOf(result.ir).nodes.map((n) => n.id);
    expect(ids).toContain('gateway_api');
    expect(ids).toContain('service_api');
  });

  it('DOES merge code + manifest app nodes for the same scan root (root-unify fixture)', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}root-unify` });
    const g = graphOf(result.ir);
    const ids = g.nodes.map((n) => n.id);
    // Exactly one root node survives — the more specific `gateway` (code), not a duplicate `service` (manifest).
    expect(ids).toContain('gateway_root_unify');
    expect(ids).not.toContain('service_billing_api');
    const root = g.nodes.find((n) => n.id === 'gateway_root_unify')!;
    expect(readProvenance(root).map((p) => p.extractor).sort()).toEqual(['code', 'manifest']);

    // The postgres node from manifest (id `postgres`) and code (`postgres_database`) also merge.
    expect(ids).toContain('postgres');
    expect(ids).not.toContain('postgres_database');
    const pg = g.nodes.find((n) => n.id === 'postgres')!;
    expect(readProvenance(pg).map((p) => p.extractor).sort()).toEqual(['code', 'manifest']);

    // Exactly one gateway->postgres edge, not two duplicates.
    const pgEdges = g.edges.filter((e) => e.to === 'postgres');
    expect(pgEdges).toHaveLength(1);
    expect(readProvenance(pgEdges[0]!).map((p) => p.extractor).sort()).toEqual(['code', 'manifest']);
  });

  it('root-unify matches the committed golden byte-for-byte and is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}root-unify` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}root-unify` });
    const golden = readFileSync(`${FIXTURE_ROOT}root-unify.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(a.ir)).toBe(golden);
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });

  it('produces structurally valid, deterministic IR', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}compose-and-manifest` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}compose-and-manifest` });
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
    expect(hasIrStructuralErrors(validateIrStructural(a.ir))).toBe(false);
  });
});

describe('lib maps — go and maven', () => {
  it('map recognized Go and Maven driver libs to canonical infra targets', () => {
    expect(GO_LIB_MAP['github.com/jackc/pgx']!.type).toBe('postgres');
    expect(GO_LIB_MAP['github.com/redis/go-redis']!.type).toBe('cache');
    expect(MAVEN_LIB_MAP['org.postgresql:postgresql']!.type).toBe('postgres');
    expect(MAVEN_LIB_MAP['org.springframework.kafka:spring-kafka']!.type).toBe('queue');
  });
});

describe('scanCodebase — manifest extractor, go.mod', () => {
  it('resolves driver libs, stripping the /vN major-version suffix before lookup', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-go`, extractors: ['manifest'] });
    const g = graphOf(result.ir);
    const ids = g.nodes.map((n) => n.id).sort();
    // github.com/jackc/pgx/v5 -> postgres; github.com/redis/go-redis/v9 -> cache;
    // github.com/segmentio/kafka-go (no version suffix) -> queue.
    expect(ids).toEqual(['cache_redis', 'postgres', 'queue_kafka', 'service_orders_api']);
  });

  it('does not match a non-driver library (gin, a web framework)', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-go`, extractors: ['manifest'] });
    const ids = graphOf(result.ir).nodes.map((n) => n.id);
    expect(ids.some((id) => id.includes('gin'))).toBe(false);
  });

  it('derives the component name from the module directive’s last path segment', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-go`, extractors: ['manifest'] });
    const component = graphOf(result.ir).nodes.find((n) => n.type === 'service')!;
    expect(component.name).toBe('orders-api');
  });

  it('matches the committed golden byte-for-byte and is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-go` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-go` });
    const golden = readFileSync(`${FIXTURE_ROOT}manifest-go.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(a.ir)).toBe(golden);
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });
});

describe('scanCodebase — manifest extractor, pom.xml (maven)', () => {
  it('resolves recognized <dependency> blocks by groupId:artifactId', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-maven`, extractors: ['manifest'] });
    const g = graphOf(result.ir);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['postgres', 'queue_kafka', 'service_billing_service']);
  });

  it('does not match a non-driver dependency (spring-boot-starter-web)', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-maven`, extractors: ['manifest'] });
    const ids = graphOf(result.ir).nodes.map((n) => n.id);
    expect(ids.some((id) => id.includes('spring-boot'))).toBe(false);
  });

  it('derives the component name from the project’s own <artifactId>, not a dependency’s', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-maven`, extractors: ['manifest'] });
    const component = graphOf(result.ir).nodes.find((n) => n.type === 'service')!;
    expect(component.name).toBe('billing-service');
  });

  it('ignores the <parent> block when naming the component', async () => {
    // Nearly every Spring Boot pom inherits from spring-boot-starter-parent, whose
    // <artifactId> is the first in the file — naming from it labelled every Java
    // service after its parent POM.
    const result = await scanCodebase({
      from: `${FIXTURE_ROOT}manifest-maven-parent`,
      extractors: ['manifest'],
    });
    const component = graphOf(result.ir).nodes.find((n) => n.type === 'service')!;
    expect(component.name).toBe('petclinic');
    expect(component.name).not.toBe('spring-boot-starter-parent');
  });

  it('matches the committed golden byte-for-byte and is deterministic', async () => {
    const a = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-maven` });
    const b = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-maven` });
    const golden = readFileSync(`${FIXTURE_ROOT}manifest-maven.expected-ir.json`, 'utf8');
    expect(canonicalIrToJsonString(a.ir)).toBe(golden);
    expect(canonicalIrToJsonString(a.ir)).toBe(canonicalIrToJsonString(b.ir));
  });

  it('produces structurally valid IR', async () => {
    const result = await scanCodebase({ from: `${FIXTURE_ROOT}manifest-maven` });
    expect(hasIrStructuralErrors(validateIrStructural(result.ir))).toBe(false);
  });
});
