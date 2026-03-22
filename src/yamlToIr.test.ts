import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseYamlToCanonicalIr, YamlGraphParseError, canonicalIrToJsonString } from './yamlToIr.js';
import { validateIrStructural, hasIrStructuralErrors } from './ir-structural.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('yamlToIr', () => {
  it('parses wrapped graph YAML', () => {
    const y = `
graph:
  metadata:
    name: demo
  nodes:
    - id: a
      type: http
      name: A
      config:
        url: /a
        method: GET
  edges: []
`;
    const ir = parseYamlToCanonicalIr(y);
    expect(ir.graph).toBeDefined();
    expect(Array.isArray((ir.graph as Record<string, unknown>).nodes)).toBe(true);
    const structural = validateIrStructural(ir);
    expect(hasIrStructuralErrors(structural)).toBe(false);
  });

  it('parses bare nodes top-level', () => {
    const y = `
nodes:
  - id: x
    type: http
    name: X
    config: { url: /x, method: GET }
edges: []
`;
    const ir = parseYamlToCanonicalIr(y);
    expect((ir.graph as Record<string, unknown>).nodes).toHaveLength(1);
  });

  it('rejects invalid root', () => {
    expect(() => parseYamlToCanonicalIr('[]')).toThrow(YamlGraphParseError);
    expect(() => parseYamlToCanonicalIr('hello')).toThrow(YamlGraphParseError);
  });

  it('rejects object without graph or nodes', () => {
    expect(() => parseYamlToCanonicalIr('foo: 1')).toThrow(YamlGraphParseError);
  });

  it('canonicalIrToJsonString ends with newline', () => {
    const s = canonicalIrToJsonString({ graph: { nodes: [] } });
    expect(s.endsWith('\n')).toBe(true);
  });

  it('minimal-graph.yaml fixture matches structural expectations', () => {
    const y = readFileSync(join(__dirname, '..', 'fixtures', 'minimal-graph.yaml'), 'utf8');
    const ir = parseYamlToCanonicalIr(y);
    const structural = validateIrStructural(ir);
    expect(hasIrStructuralErrors(structural)).toBe(false);
  });
});
