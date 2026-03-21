import { describe, it, expect } from 'vitest';
import { parseOpenApiString, validateOpenApiStructural, validateOpenApiInBundleStructural } from './openapi-structural.js';

describe('@archrad/deterministic openapi document-shape', () => {
  it('accepts minimal OpenAPI 3.0', () => {
    const yaml = `openapi: 3.0.0
info:
  title: Test
  version: '1.0'
paths:
  /signup:
    post:
      responses:
        '200':
          description: OK
`;
    const p = parseOpenApiString(yaml);
    expect(p).toBeTruthy();
    const v = validateOpenApiStructural(p!.doc);
    expect(v.ok).toBe(true);
  });

  it('validateOpenApiInBundleStructural finds openapi.yaml', () => {
    const r = validateOpenApiInBundleStructural({
      'openapi.yaml': `openapi: 3.0.0
info:
  title: T
  version: '1'
paths: {}
`,
    });
    expect(r.ok).toBe(true);
  });
});
