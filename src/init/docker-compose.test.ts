import { describe, expect, it } from 'vitest';
import { validateIrLint } from '../ir-lint.js';
import { validateIrStructural, hasIrStructuralErrors } from '../ir-structural.js';
import {
  archradLintHintsFromLabels,
  connectionUrlHost,
  dockerComposeToCanonicalIr,
  inferTypeFromImage,
} from './docker-compose.js';

describe('inferTypeFromImage', () => {
  it('maps known stacks', () => {
    expect(inferTypeFromImage('postgres:15').type).toBe('postgres');
    expect(inferTypeFromImage('redis:7-alpine').type).toBe('cache');
    expect(inferTypeFromImage('rabbitmq:3-management').type).toBe('queue');
    expect(inferTypeFromImage('nginx:alpine').type).toBe('gateway');
    expect(inferTypeFromImage('confluentinc/cp-kafka:7').type).toBe('queue');
    expect(inferTypeFromImage('minio/minio').type).toBe('storage');
  });

  it('warns on unknown image', () => {
    const r = inferTypeFromImage('mycompany/api:latest');
    expect(r.type).toBe('service');
    expect(r.warning).toBeDefined();
  });
});

describe('connectionUrlHost', () => {
  it('parses postgres and redis URLs', () => {
    expect(connectionUrlHost('postgres://postgres:5432/mydb')).toBe('postgres');
    expect(connectionUrlHost('postgresql://db:5432/app')).toBe('db');
    expect(connectionUrlHost('redis://redis:6379/0')).toBe('redis');
  });
});

describe('dockerComposeToCanonicalIr', () => {
  it('collapses depends_on and DATABASE_URL to one edge (same service pair)', () => {
    const yaml = `
services:
  api:
    image: mycompany/api:latest
    depends_on: [postgres]
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://postgres:5432/db
  postgres:
    image: postgres:15
`;
    const { ir, report } = dockerComposeToCanonicalIr(yaml);
    expect(report.services).toBe(2);
    expect(report.edges).toBe(1);
    const g = ir.graph as {
      nodes: { id: string; type: string }[];
      edges: { from: string; to: string; metadata?: Record<string, unknown> }[];
    };
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('api')).toBe(true);
    expect(ids.has('postgres')).toBe(true);
    const api = g.nodes.find((n) => n.id === 'api');
    expect(api?.type).toBe('gateway');
    expect(g.edges.length).toBe(1);
    const e = g.edges[0];
    expect(e.from).toBe('api');
    expect(e.to).toBe('postgres');
    expect(e.metadata?.relation).toBe('connectionUrl');
    expect(e.metadata?.env).toBe('DATABASE_URL');
  });

  it('does not trigger IR-LINT-DUPLICATE-EDGE-006 when depends_on and DATABASE_URL share the same pair', () => {
    const yaml = `
services:
  api:
    image: mycompany/api:latest
    depends_on: [postgres]
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://postgres:5432/db
  postgres:
    image: postgres:15
`;
    const { ir } = dockerComposeToCanonicalIr(yaml);
    const lint = validateIrLint(ir);
    const dup = lint.filter((f) => f.code === 'IR-LINT-DUPLICATE-EDGE-006');
    expect(dup).toEqual([]);
  });

  it('rejects empty services', () => {
    expect(() => dockerComposeToCanonicalIr('services: {}')).toThrow(/No services found/);
  });

  it('archradLintHintsFromLabels maps documented compose labels to IR config', () => {
    const hints = archradLintHintsFromLabels({
      'archrad.auth': 'bearer',
      'archrad.health_url': '/health',
      'archrad.http.method': 'GET',
    });
    expect(hints.auth).toBe('bearer');
    expect(hints.url).toBe('/health');
    expect(hints.method).toBe('GET');
    expect(archradLintHintsFromLabels({ 'archrad.auth_required': 'false' }).authRequired).toBe(false);
  });

  it('layered two-BC fixture passes architecture lint (no IR-LINT findings)', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const yaml = readFileSync(join(root, 'fixtures', 'docker-compose', 'demo-layered-two-bc.yml'), 'utf8');
    const { ir } = dockerComposeToCanonicalIr(yaml);
    const structural = validateIrStructural(ir);
    expect(hasIrStructuralErrors(structural)).toBe(false);
    const lint = validateIrLint(ir);
    expect(lint.filter((f) => f.layer === 'lint')).toEqual([]);
  });

  it('demo fixture passes structural validation and triggers IR-LINT-DIRECT-DB-ACCESS-002', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const yaml = readFileSync(join(root, 'fixtures', 'docker-compose', 'demo-direct-db.yml'), 'utf8');
    const { ir } = dockerComposeToCanonicalIr(yaml);
    const structural = validateIrStructural(ir);
    expect(hasIrStructuralErrors(structural)).toBe(false);
    const lint = validateIrLint(ir);
    const db = lint.filter((f) => f.code === 'IR-LINT-DIRECT-DB-ACCESS-002');
    expect(db.length).toBeGreaterThanOrEqual(1);
  });
});
