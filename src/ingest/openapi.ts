/**
 * OpenAPI spec loading for `archrad ingest openapi` — local path or http(s) URL.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const INGEST_OPENAPI_UA =
  'archrad/ingest-openapi (+https://github.com/archradhq/arch-deterministic)';

/** Parse repeatable CLI `-H "Name: value"` into header map for `fetch`. */
export function parseHeaderPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const colon = pair.indexOf(':');
    if (colon <= 0) continue;
    const name = pair.slice(0, colon).trim();
    const value = pair.slice(colon + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function isHttpOrHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Read OpenAPI document text from a local path or http(s) URL. */
export async function readOpenApiSpecInput(
  spec: string,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const trimmed = spec.trim();
  if (isHttpOrHttpsUrl(trimmed)) {
    const headers: Record<string, string> = {
      Accept: 'application/json, application/yaml, application/x-yaml, text/yaml, text/plain, */*',
      'User-Agent': INGEST_OPENAPI_UA,
      ...extraHeaders,
    };
    const res = await fetch(trimmed, {
      redirect: 'follow',
      headers,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  }
  const specPath = resolve(trimmed);
  return await readFile(specPath, 'utf8');
}
