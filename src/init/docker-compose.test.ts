import { describe, expect, it } from 'vitest';
import { validateIrLint } from '../ir-lint.js';
import { validateIrStructural, hasIrStructuralErrors } from '../ir-structural.js';
import {
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
  it('produces a graph with depends_on and DATABASE_URL edges', () => {
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
    expect(report.edges).toBeGreaterThanOrEqual(2);
    const g = ir.graph as { nodes: { id: string; type: string }[]; edges: unknown[] };
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('api')).toBe(true);
    expect(ids.has('postgres')).toBe(true);
    const api = g.nodes.find((n) => n.id === 'api');
    expect(api?.type).toBe('gateway');
    expect(g.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects empty services', () => {
    expect(() => dockerComposeToCanonicalIr('services: {}')).toThrow(/No services found/);
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
