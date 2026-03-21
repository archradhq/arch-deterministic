import { describe, it, expect } from 'vitest';
import { runDeterministicExport } from './exportPipeline.js';

describe('runDeterministicExport', () => {
  const ir = {
    graph: {
      metadata: { name: 't' },
      nodes: [
        { id: 'signup', type: 'http', name: 'Signup', config: { url: '/signup', method: 'POST' } },
        { id: 'health', type: 'http', name: 'Health', config: { url: '/health', method: 'GET' } },
      ],
      edges: [],
    },
  };

  it('generates python bundle with golden files', async () => {
    const { files, openApiStructuralWarnings, irStructuralFindings, irLintFindings } =
      await runDeterministicExport(ir, 'python', {});
    expect(files['docker-compose.yml']).toBeDefined();
    expect(files['Makefile']).toBeDefined();
    expect(files['openapi.yaml']).toBeDefined();
    expect(openApiStructuralWarnings.length).toBe(0);
    expect(irStructuralFindings.length).toBe(0);
    expect(irLintFindings.length).toBe(0);
  });

  it('returns irLintFindings when skipIrLint is false and graph triggers lint', async () => {
    const linty = {
      graph: {
        nodes: [
          { id: 'signup', type: 'http', config: { url: '/signup', method: 'POST' } },
        ],
        edges: [],
      },
    };
    const { irLintFindings } = await runDeterministicExport(linty, 'python', {});
    expect(irLintFindings.some((f) => f.code === 'IR-LINT-NO-HEALTHCHECK-003')).toBe(true);
  });

  it('skips ir lint when skipIrLint', async () => {
    const linty = {
      graph: {
        nodes: [{ id: 'signup', type: 'http', config: { url: '/signup', method: 'POST' } }],
        edges: [],
      },
    };
    const { irLintFindings } = await runDeterministicExport(linty, 'python', { skipIrLint: true });
    expect(irLintFindings.length).toBe(0);
  });

  it('returns empty files when IR has structural errors', async () => {
    const bad = {
      graph: {
        nodes: [{ id: 'a', type: 'http', config: { url: '/a', method: 'GET' } }],
        edges: [{ from: 'missing', to: 'a' }],
      },
    };
    const { files, irStructuralFindings } = await runDeterministicExport(bad, 'python', {});
    expect(Object.keys(files).length).toBe(0);
    expect(irStructuralFindings.some((f) => f.code === 'IR-STRUCT-EDGE_UNKNOWN_FROM')).toBe(true);
  });

  it('skips IR validation when skipIrStructuralValidation', async () => {
    const bad = {
      graph: {
        nodes: [{ id: 'a', type: 'http', config: { url: '/a', method: 'GET' } }],
        edges: [{ from: 'missing', to: 'a' }],
      },
    };
    const { files, irStructuralFindings } = await runDeterministicExport(bad, 'python', {
      skipIrStructuralValidation: true,
    });
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(irStructuralFindings.length).toBe(0);
  });

  it('generates node bundle', async () => {
    const { files } = await runDeterministicExport(ir, 'node', {});
    expect(files['docker-compose.yml']).toBeDefined();
    expect(files['package.json']).toBeDefined();
  });

  it('maps custom golden host port in compose and README', async () => {
    const { files } = await runDeterministicExport(ir, 'python', { hostPort: 18080 });
    expect(files['docker-compose.yml']).toContain('"18080:8080"');
    expect(files['README.md']).toContain('localhost:18080');
  });
});
