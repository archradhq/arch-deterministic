/**
 * OpenAPI 3.x **document shape**: parse JSON/YAML and check required top-level fields
 * (`openapi` version, `paths`, `info.title`, `info.version`). Not Spectral-style API lint
 * (no `security`, `operationId`, or style rules). No LLM, no network.
 */

import yaml from 'js-yaml';

export function findOpenApiInBundle(files: Record<string, string>): { path: string; content: string } | null {
  const keys = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'docs/openapi.yaml'];
  for (const k of keys) {
    const c = files[k];
    if (c && typeof c === 'string' && c.trim()) return { path: k, content: c };
  }
  return null;
}

export function parseOpenApiString(content: string): { doc: Record<string, unknown>; format: 'yaml' | 'json' } | null {
  const trimmed = content.trim();
  try {
    const doc = JSON.parse(trimmed) as Record<string, unknown>;
    if (doc && typeof doc === 'object') return { doc, format: 'json' };
  } catch {
    /* try yaml */
  }
  try {
    const doc = yaml.load(trimmed) as Record<string, unknown>;
    if (doc && typeof doc === 'object') return { doc, format: 'yaml' };
  } catch {
    return null;
  }
  return null;
}

/** Minimal **document shape** validation (parseable OpenAPI 3.x with paths + info). */
export function validateOpenApiStructural(doc: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') {
    errors.push('Document is empty or not an object');
    return { ok: false, errors };
  }
  const o = doc as Record<string, unknown>;
  const ver = o.openapi ?? o.swagger;
  if (ver === undefined || ver === null) errors.push('Missing openapi or swagger version field');
  else {
    const s = String(ver);
    if (o.openapi != null && !s.startsWith('3')) errors.push(`Expected OpenAPI 3.x, got: ${s}`);
  }
  if (!o.paths || typeof o.paths !== 'object') errors.push('Missing or invalid paths object');
  if (!o.info || typeof o.info !== 'object') errors.push('Missing info object');
  else {
    const info = o.info as Record<string, unknown>;
    if (info.title === undefined || info.title === '') errors.push('Missing info.title');
    if (info.version === undefined || info.version === '') errors.push('Missing info.version');
  }
  return { ok: errors.length === 0, errors };
}

export function serializeOpenApiDoc(doc: Record<string, unknown>, format: 'yaml' | 'json'): string {
  if (format === 'json') return JSON.stringify(doc, null, 2);
  return yaml.dump(doc, { lineWidth: 120, noRefs: true, skipInvalid: true });
}

/** Validate generated OpenAPI file in bundle (document shape only; no mutation or LLM repair). */
export function validateOpenApiInBundleStructural(files: Record<string, string>): {
  ok: boolean;
  path: string | null;
  errors: string[];
} {
  const found = findOpenApiInBundle(files);
  if (!found) {
    return { ok: true, path: null, errors: [] };
  }
  const parsed = parseOpenApiString(found.content);
  if (!parsed) {
    return { ok: false, path: found.path, errors: ['Could not parse as JSON or YAML'] };
  }
  const v = validateOpenApiStructural(parsed.doc);
  return { ok: v.ok, path: found.path, errors: v.errors };
}
