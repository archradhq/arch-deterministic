import { describe, expect, it } from 'vitest';
import { lineAt, pathFromRouteDetail } from './scan-utils.js';

describe('scan-utils', () => {
  it('lineAt returns 1-based line numbers', () => {
    const content = 'line1\nline2\nline3';
    expect(lineAt(content, 0)).toBe(1);
    expect(lineAt(content, 6)).toBe(2);
    expect(lineAt(content, 12)).toBe(3);
  });

  it('pathFromRouteDetail extracts paths from common detail shapes', () => {
    expect(pathFromRouteDetail('GET /healthz')).toBe('/healthz');
    expect(pathFromRouteDetail('@get("/ready")')).toBe('/ready');
    expect(pathFromRouteDetail('fastify.get(/health)')).toBe('/health');
    expect(pathFromRouteDetail('Map*("/products")')).toBe('/products');
  });
});
