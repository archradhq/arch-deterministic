/**
 * Topology extractor: Terraform (`*.tf`) → PartialIR (confidence: medium).
 *
 * HCL is not YAML/JSON, so this is regex + naive brace-matching, NOT a real
 * parse — the same "shallow, best-effort" technique the `code` extractor
 * already uses, and why this tier is `medium`, not `high` like `compose`/
 * `kubernetes` (both of which use a real parser). See docs/SPEC-scan.md §3.2.
 */

import type { Extractor, PartialIR } from '../types.js';
import { canonicalizeIds } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import { lineAt } from '../../reconstruct/scan-utils.js';
import {
  TERRAFORM_RESOURCE_MAP,
  refineAwsDbEngine,
  refineGoogleSqlEngine,
  relationForTargetType,
} from './terraform-resource-map.js';

const RESOURCE_HEADER = /resource\s+"([A-Za-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"\s*\{/g;

type TfResource = { resourceType: string; localName: string; irType: string; id: string; line: number; body: string };

/**
 * Naive `{`/`}` depth counter from an opening brace to its match. Does not
 * account for braces inside string literals — a known, documented corner
 * case (see SPEC §3.2), acceptable for the same reason the `code` extractor
 * accepts regex false-splits: best-effort signal, not certainty.
 */
function extractBlockBody(text: string, openBraceIndex: number): { body: string; endIndex: number } {
  let depth = 0;
  let i = openBraceIndex;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return { body: text.slice(openBraceIndex + 1, i), endIndex: i };
}

/** Extract a quoted string argument's value, e.g. `engine = "postgres"` → "postgres". */
function stringArg(body: string, key: string): string | undefined {
  const m = body.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`));
  return m?.[1];
}

/** Resolve a resource's IR type, refining the generic bucket where the engine/version matters. */
function irTypeFor(resourceType: string, body: string): string {
  const base = TERRAFORM_RESOURCE_MAP[resourceType]!.type;
  if (resourceType === 'aws_db_instance' || resourceType === 'aws_rds_cluster') {
    return refineAwsDbEngine(stringArg(body, 'engine'));
  }
  if (resourceType === 'google_sql_database_instance') {
    return refineGoogleSqlEngine(stringArg(body, 'database_version'));
  }
  return base;
}

/**
 * Terraform labels that carry no information about the component.
 *
 * `resource "aws_sqs_queue" "this"` is the idiomatic form inside a module — the
 * module IS the thing, so the label is a placeholder. Naming the component after
 * it produces a node called "this", which makes any module-style repository look
 * broken on a canvas. `main` and `default` are the same convention.
 */
const PLACEHOLDER_LABELS = new Set(['this', 'main', 'default']);

/**
 * Component name for a Terraform resource: the author's label when it says
 * something, otherwise the resource type with its provider prefix stripped
 * (`aws_sqs_queue` → `sqs queue`), which is the most specific real information
 * the declaration carries.
 */
export function terraformComponentName(resourceType: string, localName: string): string {
  if (!PLACEHOLDER_LABELS.has(localName.trim().toLowerCase())) return localName;
  const withoutProvider = resourceType.replace(
    /^(?:aws|google|azurerm|azuread|kubernetes|helm|docker|oci|alicloud|digitalocean)_/,
    '',
  );
  return (withoutProvider || resourceType).replace(/_/g, ' ');
}

/** Every `<resourceType>.<localName>` reference in `body` that names another collected resource. */
function referencedResources(body: string, resources: TfResource[], selfId: string): TfResource[] {
  const refs = new Set<string>();
  const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body))) {
    refs.add(`${m[1]}.${m[2]}`);
  }
  return resources.filter((r) => r.id !== selfId && refs.has(`${r.resourceType}.${r.localName}`));
}

export const terraformExtractor: Extractor = {
  name: 'terraform',
  defaultConfidence: 'medium',
  extract(tree): PartialIR[] {
    const partials: PartialIR[] = [];

    for (const file of tree.files) {
      if (!/\.tf$/i.test(file.relPath)) continue;
      const text = tree.read(file.relPath);
      if (!text.trim()) continue;

      const resources: TfResource[] = [];
      RESOURCE_HEADER.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RESOURCE_HEADER.exec(text))) {
        const [full, resourceType, localName] = match;
        if (!TERRAFORM_RESOURCE_MAP[resourceType!]) continue; // unrecognized type — quiet skip

        const openBraceIndex = match.index + full!.length - 1;
        const { body } = extractBlockBody(text, openBraceIndex);
        const irType = irTypeFor(resourceType!, body);
        const line = lineAt(text, match.index);
        const id = `tf_${resourceType}_${localName}`; // pre-canonical placeholder

        resources.push({ resourceType: resourceType!, localName: localName!, irType, id, line, body });
      }

      if (resources.length === 0) continue;

      const nodes: Record<string, unknown>[] = [];
      const edges: Record<string, unknown>[] = [];

      for (const r of resources) {
        nodes.push(
          withProvenance(
            {
              id: r.id,
              type: r.irType,
              name: terraformComponentName(r.resourceType, r.localName),
              config: { terraformResource: r.resourceType },
            },
            provenanceEntry('terraform', file.relPath, r.line, 'medium'),
          ),
        );
      }

      for (const r of resources) {
        for (const target of referencedResources(r.body, resources, r.id)) {
          const rel = relationForTargetType(target.irType);
          edges.push(
            withProvenance(
              {
                id: `e_${r.id}_${target.id}`,
                from: r.id,
                to: target.id,
                metadata: { relation: rel.relation, protocol: rel.protocol, async: rel.async },
              },
              provenanceEntry('terraform', file.relPath, r.line, 'medium'),
            ),
          );
        }
      }

      const canon = canonicalizeIds(nodes, edges);
      partials.push({ extractor: 'terraform', nodes: canon.nodes, edges: canon.edges, warnings: [] });
    }

    return partials;
  },
};
