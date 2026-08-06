import { describe, expect, it } from 'vitest';
import { validateIrLint } from '../ir-lint.js';
import { validateIrStructural, hasIrStructuralErrors } from '../ir-structural.js';
import {
  archradLintHintsFromLabels,
  composeDependsOnDefaultServiceKey,
  composeHealthcheckToLintHints,
  composePlainEnvHostname,
  connectionUrlHost,
  enumerateTraefikHttpBackendRefs,
  dockerComposeToCanonicalIr,
  inferTypeFromImage,
  composeLocalBuildContext,
  normalizedComposeRepositoryPath,
} from './docker-compose.js';

describe('composeDependsOnDefaultServiceKey', () => {
  it('extracts ${VAR:-service} compose default dependency target', () => {
    expect(composeDependsOnDefaultServiceKey('${_APP_DB_HOST:-mongodb}')).toBe('mongodb');
    expect(composeDependsOnDefaultServiceKey('  ${_FOO:-redis} ')).toBe('redis');
  });

  it('returns null when the entry is not a compose :-default pattern', () => {
    expect(composeDependsOnDefaultServiceKey('mongodb')).toBe(null);
    expect(composeDependsOnDefaultServiceKey('${_APP_EMPTY}')).toBe(null);
  });
});

describe('normalizedComposeRepositoryPath', () => {
  it('strips tag only on the final repo segment', () => {
    expect(normalizedComposeRepositoryPath('mcr.microsoft.com/mssql/server:2019-latest')).toBe(
      'mcr.microsoft.com/mssql/server',
    );
    expect(normalizedComposeRepositoryPath('registry:5000/acme/cache:prod')).toBe('registry:5000/acme/cache');
    expect(normalizedComposeRepositoryPath('postgres@sha256:abcd')).toBe('postgres');
  });
});

describe('inferTypeFromImage', () => {
  it('maps known stacks', () => {
    expect(inferTypeFromImage('postgres:15').type).toBe('postgres');
    expect(inferTypeFromImage('redis:7-alpine').type).toBe('cache');
    expect(inferTypeFromImage('rabbitmq:3-management').type).toBe('queue');
    expect(inferTypeFromImage('nginx:alpine').type).toBe('gateway');
    expect(inferTypeFromImage('confluentinc/cp-kafka:7').type).toBe('queue');
    expect(inferTypeFromImage('minio/minio').type).toBe('storage');
    expect(inferTypeFromImage('quay.io/keycloak/keycloak:24').type).toBe('keycloak');
    expect(inferTypeFromImage('maildev/maildev').type).toBe('smtp');
    expect(inferTypeFromImage('coredns/coredns:2').type).toBe('dns');
  });

  it('maps datastores the IR models to their own type, not the generic postgres bucket', () => {
    // These four have dedicated IR node types (the code extractor already emits
    // them via dbNodeType), so the compose tier must agree or cross-tier
    // unification cannot match them up.
    expect(inferTypeFromImage('mongo:4.2.1-bionic').type).toBe('mongodb');
    expect(inferTypeFromImage('mongodb/mongodb-community-server').type).toBe('mongodb');
    expect(inferTypeFromImage('mysql:8').type).toBe('mysql');
    expect(inferTypeFromImage('mariadb:11').type).toBe('mysql');
    expect(inferTypeFromImage('cassandra:5').type).toBe('cassandra');
    expect(inferTypeFromImage('mcr.microsoft.com/mssql/server:2019-latest').type).toBe('sqlserver');
  });

  it('does not treat a local emulator/test double as an HTTP gateway', () => {
    // fauxqs (an SQS/SNS emulator) publishes a port and has an unrecognised
    // image, but it stands in for a cloud service in dev — linting it as a
    // public HTTP entry produced false MISSING-AUTH / ISOLATED-NODE findings.
    const yaml = `
services:
  fauxqs:
    image: kibertoad/fauxqs:latest
    ports: ["4566:4566"]
  api:
    image: mycompany/api:latest
    ports: ["8080:8080"]
`;
    const { ir } = dockerComposeToCanonicalIr(yaml);
    const nodes = (ir.graph as { nodes: { id: string; type: string }[] }).nodes;
    expect(nodes.find((n) => n.id.includes('fauxqs'))?.type).toBe('service');
    // A pulled but plausibly-real API image is still promoted to a gateway.
    expect(nodes.find((n) => n.id.includes('api'))?.type).toBe('gateway');
  });

  it('distinguishes a repo-root build context from a subdirectory one', () => {
    // '.' means the app itself; a subdirectory is a sibling component (test
    // harness, migration job) that must never be merged into the app root.
    expect(composeLocalBuildContext({ build: '.' })).toBe('.');
    expect(composeLocalBuildContext({ build: './' })).toBe('.');
    expect(composeLocalBuildContext({ build: {} })).toBe('.');
    expect(composeLocalBuildContext({ build: { context: '.' } })).toBe('.');
    expect(composeLocalBuildContext({ build: './tests/' })).toBe('tests');
    expect(composeLocalBuildContext({ build: { context: './vote' } })).toBe('vote');
    // Not a local build at all.
    expect(composeLocalBuildContext({ image: 'postgres:15' })).toBeNull();
    expect(composeLocalBuildContext({ build: 'https://github.com/acme/repo.git' })).toBeNull();
  });

  it('keeps unmodelled datastores in the generic postgres bucket', () => {
    expect(inferTypeFromImage('postgres:15').type).toBe('postgres');
    expect(inferTypeFromImage('clickhouse/clickhouse-server').type).toBe('postgres');
    expect(inferTypeFromImage('neo4j:5').type).toBe('postgres');
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


describe('composePlainEnvHostname', () => {
  it('parses Compose service DNS names and host:port', () => {
    expect(composePlainEnvHostname('postgres')).toBe('postgres');
    expect(composePlainEnvHostname('"redis"')).toBe('redis');
    expect(composePlainEnvHostname('db.internal:5432')).toBe('db.internal');
  });

  it('rejects JDBC/HTTP URLs and ${VAR} templates', () => {
    expect(composePlainEnvHostname('postgres://db:5432/app')).toBe(null);
    expect(composePlainEnvHostname('${_PGHOST}')).toBe(null);
  });
});

describe('composeHealthcheckToLintHints', () => {
  it('parses CMD-SHELL + curl blobs for /health', () => {
    const h = composeHealthcheckToLintHints({
      test: ['CMD-SHELL', 'curl -fsS http://localhost:8080/health || exit 1'],
    });
    expect(h.url).toBe('/health');
    expect(h.method).toBe('GET');
  });

  it('parses wget /healthy (Mastodon-style)', () => {
    expect(
      composeHealthcheckToLintHints({
        test: 'wget -qO- http://127.0.0.1:4000/healthy || exit 1',
      }).url,
    ).toBe('/healthy');
  });

  it('returns empty hints when there is no HTTP probe tooling', () => {
    expect(composeHealthcheckToLintHints({ test: 'echo OK' }).url).toBeUndefined();
  });
});

describe('enumerateTraefikHttpBackendRefs', () => {
  it('reads loadbalancer service segment and routers.*.service value', () => {
    const s = enumerateTraefikHttpBackendRefs({
      'traefik.http.services.api_svc.loadbalancer.server.port': '8080',
      'traefik.http.routers.web.service': 'api_svc',
    });
    expect([...s].sort()).toEqual(['api_svc']);
  });
});

describe('dockerComposeToCanonicalIr', () => {
  it('resolves Traefik router/service labels into traefikIngress edges', () => {
    const yaml = `
services:
  traefik:
    image: traefik:v3
    labels:
      - traefik.http.services.api_svc.loadbalancer.server.port=8080
      - traefik.http.routers.web.service=api_svc
  api-svc:
    image: nginx:alpine
`;
    const { ir } = dockerComposeToCanonicalIr(yaml);
    const edges = (ir.graph as { edges: { from: string; to: string; metadata?: Record<string, unknown> }[] }).edges;
    expect(
      edges.some((e) => e.metadata?.relation === 'traefikIngress' && e.metadata?.traefikBackend === 'api_svc'),
    ).toBe(true);
  });

  it('expands interpolateFrom for depends_on hyphen-default (${DB_HOST-db})', () => {
    const yaml = `
services:
  api:
    image: mycompany/api:latest
    depends_on:
      - \${DB_HOST-db}
  db:
    image: postgres:15
`;
    const { ir } = dockerComposeToCanonicalIr(yaml, { interpolateFrom: {} });
    const g = ir.graph as {
      nodes: { id: string; name?: string }[];
      edges: { from: string; to: string }[];
    };
    const apiId = g.nodes.find((n) => n.name === 'api')!.id;
    const dbId = g.nodes.find((n) => n.name === 'db')!.id;
    expect(g.edges.some((e) => e.from === apiId && e.to === dbId)).toBe(true);
  });

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

  it('does not classify multi-engine database matrix services as HTTP gateways', () => {
    const yaml = `
services:
  mysql:
    image: mysql:8
    ports: ["3306:3306"]
  postgres:
    image: postgres:15
    ports: ["5432:5432"]
  mssql:
    image: mcr.microsoft.com/mssql/server:2019-latest
    ports: ["1433:1433"]
`;
    const { ir } = dockerComposeToCanonicalIr(yaml);
    const lint = validateIrLint(ir);
    expect(lint.some((f) => f.code === 'IR-LINT-MISSING-AUTH-010')).toBe(false);
    expect(lint.some((f) => f.code === 'IR-LINT-MULTIPLE-HTTP-ENTRIES-009')).toBe(false);
    expect(lint.some((f) => f.code === 'IR-LINT-NO-HEALTHCHECK-003')).toBe(false);
    const nodes = (ir.graph as { nodes: { id: string; type: string }[] }).nodes;
    expect(nodes.find((n) => n.id === 'mssql')?.type).toBe('sqlserver');
  });

  it('maps depends_on ${_VAR:-mongodb} literals to mongodb edges (Compose default syntax)', () => {
    const yaml = `
services:
  worker-migrations:
    image: demo/worker:latest
    depends_on:
      - \${_FOO:-mongodb}
  mongodb:
    image: mongo:8
`;
    const { ir, report } = dockerComposeToCanonicalIr(yaml);
    expect(report.warnings.every((w) => !w.includes('unknown service'))).toBe(true);
    expect(report.edges).toBeGreaterThanOrEqual(1);
    const g = ir.graph as { edges: { from: string; to: string }[] };
    const hit = g.edges.some((e) => e.from === 'worker_migrations' && e.to === 'mongodb');
    expect(hit).toBe(true);
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

  it('maps POSTGRES_HOST / REDIS_HOST to edges without full URLs', () => {
    const yaml = `
services:
  web:
    image: mastodon:dev
    ports: ["3000:3000"]
    environment:
      POSTGRES_HOST: db
      REDIS_HOST: redis
  db:
    image: postgres:15
  redis:
    image: redis:7
`;
    const { ir, report } = dockerComposeToCanonicalIr(yaml);
    expect(report.edges).toBeGreaterThanOrEqual(2);
    const g = ir.graph as { edges: { from: string; to: string; metadata?: Record<string, unknown> }[] };
    const hasDb = g.edges.some(
      (e) => e.from === 'web' && e.to === 'db' && e.metadata?.env === 'POSTGRES_HOST',
    );
    const hasRedis = g.edges.some(
      (e) => e.from === 'web' && e.to === 'redis' && e.metadata?.env === 'REDIS_HOST',
    );
    expect(hasDb).toBe(true);
    expect(hasRedis).toBe(true);
  });

  it('uses compose healthcheck curl/wget to seed config.url for NO-HEALTHCHECK rule', () => {
    const yaml = `
services:
  web:
    image: mastodon:dev
    ports: ["3000:3000"]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:3000/healthy || exit 1"]
`;
    const { ir } = dockerComposeToCanonicalIr(yaml);
    const web = (ir.graph as { nodes: { id: string; config?: Record<string, unknown> }[] }).nodes.find(
      (n) => n.id === 'web',
    );
    expect(web?.config?.url).toBe('/healthy');
    expect(validateIrLint(ir).some((f) => f.code === 'IR-LINT-NO-HEALTHCHECK-003')).toBe(false);
  });

  it('rejects empty services', () => {
    expect(() => dockerComposeToCanonicalIr('services: {}')).toThrow(/No services found/);
  });

  it('accepts multi-document YAML when the first document is empty (leading ---)', () => {
    const yaml = `---
---
services:
  web:
    image: nginx:alpine
`;
    const { report } = dockerComposeToCanonicalIr(yaml);
    expect(report.services).toBe(1);
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
