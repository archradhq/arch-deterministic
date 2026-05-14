import { describe, expect, it } from 'vitest';
import {
  composeInterpolationBindings,
  expandComposeVars,
  parseDotEnvText,
} from './compose-vars.js';

describe('parseDotEnvText', () => {
  it('parses KEY= assignments and strips export', () => {
    expect(
      parseDotEnvText(`# hi
FOO=x
export BAR=y
`),
    ).toEqual({ FOO: 'x', BAR: 'y' });
  });
});

describe('expandComposeVars', () => {
  it('handles $$ concat and ${VAR}, ${VAR:-default}, ${VAR-hyphen}', () => {
    expect(
      expandComposeVars('$' + '$' + '{FOO}', {
        FOO: 'bar',
      }),
    ).toBe('$bar');
    expect(expandComposeVars('a$$b', {})).toBe('a$b');
    expect(
      expandComposeVars('x ${EMPTY:-mongodb} ${PLAIN-mysql}', {
        EMPTY: '',
        OTHER: '',
      }),
    ).toBe('x mongodb mysql');
    expect(
      expandComposeVars('${_APP_DB_HOST:-mongo}', {}),
    ).toBe('mongo');
  });
});

describe('composeInterpolationBindings', () => {
  it('merges dotenv overlays after process bindings so file wins', () => {
    const key = `_ARCHRAD_TEST_BIND_${Math.random().toString(36).slice(2)}`;
    process.env[key] = 'from-process';
    try {
      const merged = composeInterpolationBindings({ [key]: 'from-explicit' }, true);
      expect(merged[key]).toBe('from-explicit');
    } finally {
      delete process.env[key];
    }
  });
});
