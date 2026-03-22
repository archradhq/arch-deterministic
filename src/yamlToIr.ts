/**
 * Convert a YAML blueprint file into canonical IR JSON shape for validate/export.
 * YAML mirrors JSON IR: either `{ graph: { metadata?, nodes, edges? } }` or a bare `{ nodes, edges?, metadata? }`.
 */

import yaml from 'js-yaml';

export class YamlGraphParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YamlGraphParseError';
  }
}

/**
 * Parse YAML text and return `{ graph: { ... } }` suitable for `validateIrStructural` / `runDeterministicExport`.
 */
export function parseYamlToCanonicalIr(yamlText: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new YamlGraphParseError(`Invalid YAML: ${msg}`);
  }

  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new YamlGraphParseError(
      'YAML root must be a mapping (object), not null, a scalar, or a sequence at the top level.'
    );
  }

  const o = doc as Record<string, unknown>;

  if (o.graph != null && typeof o.graph === 'object' && !Array.isArray(o.graph)) {
    return { graph: o.graph as Record<string, unknown> };
  }

  if (Array.isArray(o.nodes)) {
    return { graph: { ...o } };
  }

  throw new YamlGraphParseError(
    'YAML must define either top-level `graph:` (object) or top-level `nodes:` (array). See fixtures/minimal-graph.yaml.'
  );
}

/** Pretty-printed JSON for stable CLI output (2-space indent + trailing newline). */
export function canonicalIrToJsonString(ir: Record<string, unknown>): string {
  return `${JSON.stringify(ir, null, 2)}\n`;
}
