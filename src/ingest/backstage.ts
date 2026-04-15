/**
 * Backstage catalog-info.yaml → ArchRad IR (organizational topology).
 * Maps Component, Resource, API, System; follows Location targets; skips node_modules / dist / .git.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { stripLeadingTrailingUnderscores } from '../stringEdgeStrip.js';

export class BackstageIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackstageIngestError';
  }
}

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'build', 'coverage', '.next', 'target']);

export type BackstageIngestReport = {
  catalogFilesScanned: number;
  locationsFollowed: number;
  entitiesByKind: Record<string, number>;
  skipped: { path: string; reason: string }[];
};

function slug(s: string, max = 48): string {
  const t = stripLeadingTrailingUnderscores(String(s).replace(/[^a-zA-Z0-9]+/g, '_')).toLowerCase();
  return (t || 'x').slice(0, max);
}

/** Walk recursively for `catalog-info.yaml` / `catalog.yaml`, skipping excluded dirs. */
export async function walkCatalogInfoFiles(rootAbs: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.name === 'catalog-info.yaml' || e.name === 'catalog.yaml') {
        out.push(p);
      }
    }
  }

  await walk(resolve(rootAbs));
  return out.sort();
}

/** Resolve Location target relative to the catalog file directory or absolute. */
export function resolveLocationTarget(fromCatalogFile: string, target: string): string | null {
  const t = String(target).trim();
  if (!t) return null;
  if (t.startsWith('http://') || t.startsWith('https://')) {
    return null;
  }
  const base = dirname(fromCatalogFile);
  const abs = resolve(base, t);
  return abs;
}

export function parseEntityRef(ref: string): { kind: string; namespace: string; name: string } | null {
  const s = String(ref).trim();
  const m = s.match(/^(component|resource|api|system):([^/]+)\/([^/]+)$/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase(), namespace: m[2], name: m[3] };
}

function entityRef(kind: string, namespace: string, name: string): string {
  return `${kind.toLowerCase()}:${namespace}/${name}`;
}

function nodeIdForEntity(kind: string, namespace: string, name: string): string {
  return `bs_${slug(kind)}_${slug(namespace)}_${slug(name)}`.slice(0, 80);
}

function mapResourceTypeToNodeType(specType: string): string {
  const t = String(specType || '').toLowerCase();
  if (t.includes('database') || t === 'db' || t === 'postgres' || t === 'mysql') return 'postgres';
  if (t.includes('redis') || t.includes('cache')) return 'redis';
  if (t.includes('queue') || t.includes('kafka') || t.includes('sqs')) return 'queue';
  return 'service';
}

function mapComponentSpecType(specType: string): string {
  const t = String(specType || 'service').toLowerCase();
  if (t === 'website' || t === 'library' || t === 'service') return 'service';
  return 'service';
}

type ParsedEntity = {
  path: string;
  kind: string;
  namespace: string;
  name: string;
  ref: string;
  doc: Record<string, unknown>;
};

function parseCatalogDocument(raw: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(raw) as unknown;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    return doc as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Expand catalog paths by following Location entities (file targets only). */
export async function collectCatalogPaths(rootAbs: string, report: BackstageIngestReport): Promise<string[]> {
  const discovered = new Set<string>();
  const queue: string[] = [];

  for (const p of await walkCatalogInfoFiles(rootAbs)) {
    queue.push(p);
  }

  let locCount = 0;
  while (queue.length > 0) {
    const p = queue.pop()!;
    if (discovered.has(p)) continue;
    discovered.add(p);

    let raw: string;
    try {
      raw = await readFile(p, 'utf8');
    } catch (e) {
      report.skipped.push({ path: p, reason: `read failed: ${String(e)}` });
      continue;
    }

    const doc = parseCatalogDocument(raw);
    if (!doc || typeof doc.kind !== 'string') {
      report.skipped.push({ path: p, reason: 'invalid or empty YAML' });
      continue;
    }

    if (doc.kind === 'Location') {
      locCount++;
      const spec = doc.spec && typeof doc.spec === 'object' ? (doc.spec as Record<string, unknown>) : {};
      const targets = Array.isArray(spec.targets)
        ? spec.targets
        : spec.target != null
          ? [spec.target]
          : [];
      for (const t of targets) {
        if (typeof t !== 'string') continue;
        if (t.startsWith('http://') || t.startsWith('https://')) {
          report.skipped.push({ path: p, reason: `Location URL target not loaded: ${t.slice(0, 48)}…` });
          continue;
        }
        const abs = resolveLocationTarget(p, t);
        if (!abs || !existsSync(abs)) {
          report.skipped.push({ path: p, reason: `Location target missing: ${t}` });
          continue;
        }
        if (!discovered.has(abs)) queue.push(abs);
      }
    }
  }

  report.locationsFollowed = locCount;
  return [...discovered].sort();
}

const MAPPED_KINDS = new Set(['Component', 'Resource', 'API', 'System']);

function toParsedEntity(path: string, doc: Record<string, unknown>): ParsedEntity | null {
  const kind = typeof doc.kind === 'string' ? doc.kind : '';
  if (!MAPPED_KINDS.has(kind)) return null;
  const meta = doc.metadata && typeof doc.metadata === 'object' ? (doc.metadata as Record<string, unknown>) : {};
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name) return null;
  const namespace = typeof meta.namespace === 'string' ? meta.namespace.trim() : 'default';
  const ref = entityRef(kind, namespace, name);
  return { path, kind, namespace, name, ref, doc };
}

/**
 * Ingest Backstage YAML catalogs under `catalogRoot` into canonical IR `{ metadata?, graph }`.
 */
export async function ingestBackstageCatalog(
  catalogRoot: string,
): Promise<{ ir: Record<string, unknown>; report: BackstageIngestReport }> {
  const report: BackstageIngestReport = {
    catalogFilesScanned: 0,
    locationsFollowed: 0,
    entitiesByKind: {},
    skipped: [],
  };

  const rootAbs = resolve(catalogRoot);
  if (!existsSync(rootAbs)) {
    throw new BackstageIngestError(`catalog root not found: ${rootAbs}`);
  }

  const paths = await collectCatalogPaths(rootAbs, report);
  report.catalogFilesScanned = paths.length;

  const entities: ParsedEntity[] = [];

  for (const p of paths) {
    let raw: string;
    try {
      raw = await readFile(p, 'utf8');
    } catch (e) {
      report.skipped.push({ path: p, reason: String(e) });
      continue;
    }
    const doc = parseCatalogDocument(raw);
    if (!doc || typeof doc.kind !== 'string') {
      report.skipped.push({ path: p, reason: 'unparseable YAML' });
      continue;
    }
    if (doc.kind === 'Location') continue;

    const pe = toParsedEntity(p, doc);
    if (!pe) {
      report.skipped.push({ path: p, reason: `unsupported kind: ${doc.kind}` });
      continue;
    }
    entities.push(pe);
    report.entitiesByKind[pe.kind] = (report.entitiesByKind[pe.kind] ?? 0) + 1;
  }

  const refToNodeId = new Map<string, string>();
  for (const e of entities) {
    refToNodeId.set(e.ref, nodeIdForEntity(e.kind, e.namespace, e.name));
  }

  const nodes: Record<string, unknown>[] = [];
  const edges: { from: string; to: string; metadata: Record<string, unknown> }[] = [];

  for (const e of entities) {
    const id = refToNodeId.get(e.ref)!;
    const meta = e.doc.metadata && typeof e.doc.metadata === 'object' ? (e.doc.metadata as Record<string, unknown>) : {};
    const title = typeof meta.title === 'string' ? meta.title : e.name;
    const spec = e.doc.spec && typeof e.doc.spec === 'object' ? (e.doc.spec as Record<string, unknown>) : {};

    let type = 'service';
    let name = title;
    const config: Record<string, unknown> = {
      backstageKind: e.kind,
      backstageNamespace: e.namespace,
      catalogPath: e.path,
    };

    if (e.kind === 'Component') {
      type = mapComponentSpecType(String(spec.type ?? 'service'));
      if (spec.lifecycle) config.lifecycle = spec.lifecycle;
      if (spec.owner) config.owner = spec.owner;
    } else if (e.kind === 'Resource') {
      type = mapResourceTypeToNodeType(String(spec.type ?? 'resource'));
    } else if (e.kind === 'API') {
      type = 'api';
      if (spec.lifecycle) config.lifecycle = spec.lifecycle;
    } else if (e.kind === 'System') {
      type = 'service';
    }

    nodes.push({
      id,
      type,
      kind: type,
      name,
      config,
    });

    if (e.kind === 'Component') {
      const sys = spec.system;
      if (typeof sys === 'string' && sys.trim()) {
        let sysRef = parseEntityRef(sys.trim());
        if (!sysRef) {
          sysRef = { kind: 'system', namespace: e.namespace, name: sys.trim() };
        }
        const fullRef = entityRef('system', sysRef.namespace, sysRef.name);
        const tid = refToNodeId.get(fullRef);
        if (tid) {
          edges.push({
            from: id,
            to: tid,
            metadata: { protocol: 'backstage', async: false, relation: 'system' },
          });
        }
      }

      const dep = spec.dependsOn;
      if (Array.isArray(dep)) {
        for (const r of dep) {
          if (typeof r !== 'string') continue;
          const pr = parseEntityRef(r.trim());
          if (!pr) continue;
          const fullRef = entityRef(pr.kind, pr.namespace, pr.name);
          const tid = refToNodeId.get(fullRef);
          if (tid) {
            edges.push({
              from: id,
              to: tid,
              metadata: { protocol: 'backstage', async: false, relation: 'dependsOn' },
            });
          }
        }
      }
    }
  }

  if (nodes.length === 0) {
    throw new BackstageIngestError(
      'No Component, Resource, API, or System entities found under catalog root (check catalog-info.yaml files).',
    );
  }

  const ir: Record<string, unknown> = {
    metadata: { name: 'backstage-ingest' },
    graph: {
      metadata: {
        name: 'backstage-ingest',
        provenance: { source: 'backstage-ingest', catalogRoot: rootAbs },
      },
      nodes,
      edges,
    },
  };

  return { ir, report };
}
