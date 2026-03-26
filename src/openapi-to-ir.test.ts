import { describe, it, expect } from 'vitest';
import {
  openApiDocumentToCanonicalIr,
  openApiDocumentToHttpNodes,
  openApiStringToCanonicalIr,
  OpenApiIngestError,
} from './openapi-to-ir.js';
import { validateIrStructural, hasIrStructuralErrors } from './ir-structural.js';

describe('openapi-to-ir', () => {
  const minimalDoc = {
    openapi: '3.0.0',
    info: { title: 'Pet Store API', version: '1.0.0' },
    paths: {
      '/pets': {
        get: { summary: 'List pets' },
        post: { operationId: 'createPet' },
      },
      'health': {
        get: { summary: 'Health' },
      },
    },
  };

  it('openApiDocumentToHttpNodes yields http nodes with url + route', () => {
    const nodes = openApiDocumentToHttpNodes(minimalDoc as Record<string, unknown>);
    expect(nodes.length).toBe(3);
    const getPets = nodes.find((n) => n.config.method === 'GET' && n.config.url === '/pets');
    expect(getPets?.name).toBe('List pets');
    expect(getPets?.config.route).toBe('/pets');
    const postPets = nodes.find((n) => n.config.method === 'POST' && n.config.url === '/pets');
    expect(postPets?.config.operationId).toBe('createPet');
    const health = nodes.find((n) => n.config.url === '/health');
    expect(health).toBeDefined();
  });

  it('openApiDocumentToCanonicalIr wraps graph + metadata and passes structural validation', () => {
    const ir = openApiDocumentToCanonicalIr(minimalDoc as Record<string, unknown>);
    expect(ir.metadata).toMatchObject({ name: 'pet-store-api' });
    const g = ir.graph as Record<string, unknown>;
    expect((g.metadata as Record<string, unknown>).provenance).toMatchObject({
      source: 'openapi-ingest',
      specTitle: 'Pet Store API',
    });
    expect(Array.isArray(g.nodes)).toBe(true);
    const findings = validateIrStructural(ir);
    expect(hasIrStructuralErrors(findings)).toBe(false);
  });

  it('openApiStringToCanonicalIr parses YAML', () => {
    const yaml = `openapi: 3.0.0
info:
  title: T
  version: "1"
paths:
  /x:
    get: {}
`;
    const ir = openApiStringToCanonicalIr(yaml);
    const nodes = (ir.graph as { nodes: unknown[] }).nodes;
    expect(nodes.length).toBe(1);
  });

  it('throws when no operations under paths', () => {
    expect(() =>
      openApiDocumentToCanonicalIr({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: {},
      } as Record<string, unknown>)
    ).toThrow(OpenApiIngestError);
  });
});
