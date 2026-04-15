import { describe, expect, it } from 'vitest';
import { parseHeaderPairs } from './openapi.js';

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
