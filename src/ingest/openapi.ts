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

export const DEFAULT_ARCHRAD_UA =
  'archrad (+https://github.com/archradhq/arch-deterministic)';

export type ReadTextFromPathOrUrlOptions = {
  extraHeaders?: Record<string, string>;
  /** Default: YAML + JSON + plain (GitHub raw works). */
  accept?: string;
  userAgent?: string;
};

/**
 * Read text from a local path or http(s) URL — shared by OpenAPI ingest, `yaml-to-ir`, etc.
 */
export async function readTextFromPathOrUrl(
  pathOrUrl: string,
  opts?: ReadTextFromPathOrUrlOptions,
): Promise<string> {
  const trimmed = pathOrUrl.trim();
  if (isHttpOrHttpsUrl(trimmed)) {
    const headers: Record<string, string> = {
      Accept:
        opts?.accept ??
        'text/plain, text/yaml, application/yaml, application/x-yaml, application/json, */*',
      'User-Agent': opts?.userAgent ?? DEFAULT_ARCHRAD_UA,
      ...opts?.extraHeaders,
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
  return await readFile(resolve(trimmed), 'utf8');
}

/** Read OpenAPI document text from a local path or http(s) URL. */
export async function readOpenApiSpecInput(
  spec: string,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  return readTextFromPathOrUrl(spec, {
    extraHeaders,
    accept: 'application/json, application/yaml, application/x-yaml, text/yaml, text/plain, */*',
    userAgent: INGEST_OPENAPI_UA,
  });
}
