import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHeaderPairs, readTextFromPathOrUrl } from './openapi.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('parseHeaderPairs', () => {
  it('parses Name: value lines', () => {
    expect(parseHeaderPairs(['Authorization: Bearer x', 'X-Custom: y'])).toEqual({
      Authorization: 'Bearer x',
      'X-Custom': 'y',
    });
  });

  it('ignores invalid lines', () => {
    expect(parseHeaderPairs(['no-colon', ': empty name'])).toEqual({});
  });
});

describe('readTextFromPathOrUrl', () => {
  it('reads a local file', async () => {
    const p = join(pkgRoot, 'fixtures', 'minimal-graph.yaml');
    const a = await readTextFromPathOrUrl(p);
    const b = await readFile(p, 'utf8');
    expect(a).toBe(b);
  });
});
