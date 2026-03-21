import { describe, it, expect } from 'vitest';
import { DEFAULT_GOLDEN_HOST_PORT, normalizeGoldenHostPort } from './hostPort.js';

describe('normalizeGoldenHostPort', () => {
  it('defaults invalid values to 8080', () => {
    expect(normalizeGoldenHostPort(undefined)).toBe(DEFAULT_GOLDEN_HOST_PORT);
    expect(normalizeGoldenHostPort('')).toBe(DEFAULT_GOLDEN_HOST_PORT);
    expect(normalizeGoldenHostPort(0)).toBe(DEFAULT_GOLDEN_HOST_PORT);
    expect(normalizeGoldenHostPort(70000)).toBe(DEFAULT_GOLDEN_HOST_PORT);
    expect(normalizeGoldenHostPort('abc')).toBe(DEFAULT_GOLDEN_HOST_PORT);
  });

  it('accepts valid ports', () => {
    expect(normalizeGoldenHostPort(3000)).toBe(3000);
    expect(normalizeGoldenHostPort('9090')).toBe(9090);
  });
});
