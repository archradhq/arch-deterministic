import { describe, it, expect } from 'vitest';
import { runDeterministicExport } from './exportPipeline.js';

describe('runDeterministicExport', () => {
  const ir = {
    graph: {
      metadata: { name: 't' },
      nodes: [
        { id: 'signup', type: 'http', name: 'Signup', config: { url: '/signup', method: 'POST' } },
      ],
      edges: [],
    },
  };

  it('generates python bundle with golden files', async () => {
    const { files, openApiStructuralWarnings } = await runDeterministicExport(ir, 'python', {});
    expect(files['docker-compose.yml']).toBeDefined();
    expect(files['Makefile']).toBeDefined();
    expect(files['openapi.yaml']).toBeDefined();
    expect(openApiStructuralWarnings.length).toBe(0);
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
