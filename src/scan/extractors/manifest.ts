/**
 * Manifest extractor: package.json / requirements.txt / go.mod / pom.xml →
 * PartialIR (confidence: low).
 *
 * Maps *driver-level* client libraries to infrastructure edges via
 * {@link NPM_LIB_MAP} / {@link PIP_LIB_MAP} / {@link GO_LIB_MAP} /
 * {@link MAVEN_LIB_MAP}. For each manifest with at least one recognized
 * library it emits: one component (service) node, one infra node per
 * recognized dependency (canonical id — see lib-map), and a component→infra
 * edge.
 *
 * Manifests with no recognized dependency are skipped entirely, so monorepos full
 * of tooling package.json files do not flood the draft with empty service nodes.
 */

import { basename, dirname } from 'node:path';
import type { Extractor, PartialIR } from '../types.js';
import { scanNodeId } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import { NPM_LIB_MAP, PIP_LIB_MAP, GO_LIB_MAP, MAVEN_LIB_MAP, type InfraTarget } from './lib-map.js';

/** One recognized dependency: the library name, its infra target, and source line. */
type Hit = { lib: string; target: InfraTarget; line: number };

/** 1-based line of the first occurrence of `needle` in `text`, or 1 if absent. */
function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  if (idx < 0) return 1;
  return text.slice(0, idx).split('\n').length;
}

/** Parse package.json runtime `dependencies` into recognized infra hits. */
function npmHits(text: string): Hit[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object') return [];
  const deps = (json as Record<string, unknown>).dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return [];
  const hits: Hit[] = [];
  for (const lib of Object.keys(deps as Record<string, unknown>)) {
    const target = NPM_LIB_MAP[lib];
    if (target) hits.push({ lib, target, line: lineOf(text, `"${lib}"`) });
  }
  return hits;
}

/** Component name from package.json `name`, else null. */
function npmComponentName(text: string): string | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const name = json.name;
    return typeof name === 'string' && name.trim() ? name : null;
  } catch {
    return null;
  }
}

/** Parse a requirements.txt line into a normalized package name, or null. */
export function parseRequirementLine(line: string): string | null {
  const stripped = line.replace(/#.*$/, '').trim();
  if (!stripped || stripped.startsWith('-')) return null; // blank / option line (-r, --hash, …)
  const m = stripped.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  if (!m) return null;
  return m[1]!.toLowerCase();
}

/** Parse requirements.txt into recognized infra hits. */
function pipHits(text: string): Hit[] {
  const lines = text.split(/\r?\n/);
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = parseRequirementLine(lines[i]!);
    if (!name) continue;
    const target = PIP_LIB_MAP[name];
    if (target) hits.push({ lib: name, target, line: i + 1 });
  }
  return hits;
}

/** Strip a trailing Go module major-version suffix (`/v2`, `/v5`, …) before lookup. */
function stripGoModuleVersion(modulePath: string): string {
  return modulePath.replace(/\/v\d+$/, '');
}

/** Parse go.mod `require (...)` blocks and single-line `require <module> v<version>` into recognized infra hits. */
function goModHits(text: string): Hit[] {
  const modulePaths = new Set<string>();

  const block = text.match(/require\s*\(([\s\S]*?)\)/);
  if (block) {
    for (const line of block[1]!.split(/\r?\n/)) {
      const m = line.trim().match(/^(\S+)\s+v\S+/);
      if (m) modulePaths.add(m[1]!);
    }
  }
  for (const m of text.matchAll(/^require\s+(\S+)\s+v\S+/gm)) {
    modulePaths.add(m[1]!);
  }

  const hits: Hit[] = [];
  for (const modulePath of modulePaths) {
    const target = GO_LIB_MAP[stripGoModuleVersion(modulePath)];
    if (target) hits.push({ lib: modulePath, target, line: lineOf(text, modulePath) });
  }
  return hits;
}

/** Component name from go.mod's `module` directive — the last path segment. */
function goModComponentName(text: string): string | null {
  const m = text.match(/^module\s+(\S+)/m);
  if (!m) return null;
  const segments = m[1]!.split('/');
  return segments[segments.length - 1] || null;
}

/** Parse pom.xml `<dependency>` blocks into recognized infra hits (regex, not a real XML parse). */
function mavenHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = m[1]!;
    const groupId = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const artifactId = block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    if (!groupId || !artifactId) continue;
    const key = `${groupId}:${artifactId}`;
    const target = MAVEN_LIB_MAP[key];
    if (target) hits.push({ lib: key, target, line: lineOf(text, m[0]) });
  }
  return hits;
}

/**
 * Component name for a pom.xml.
 *
 * The `<parent>` block MUST be stripped first: nearly every Spring Boot project
 * inherits from `spring-boot-starter-parent`, and that block's `<artifactId>` is
 * the first one in the file — so reading it naively names every Java service
 * after its parent POM rather than itself.
 *
 * Prefers `<name>` when present. Maven treats it as the project's display name,
 * and it is what deployment resources are conventionally named after, so it
 * aligns with the compose/Kubernetes tiers' view of the same component. Falls
 * back to the project's own `<artifactId>`, which is always present.
 */
function mavenComponentName(text: string): string | null {
  const withoutParent = text.replace(/<parent>[\s\S]*?<\/parent>/g, '');
  const displayName = withoutParent.match(/<name>([^<]+)<\/name>/)?.[1]?.trim();
  if (displayName && !displayName.includes('${')) return displayName;
  // Stop before <dependencies> so a dependency's artifactId can never win.
  const beforeDeps = withoutParent.split(/<dependencies>/)[0] ?? withoutParent;
  return beforeDeps.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim() || null;
}

/** Derive a component name for a manifest that has no explicit name field. */
function dirComponentName(relPath: string, root: string): string {
  const dir = dirname(relPath);
  if (dir && dir !== '.' ) return basename(dir);
  return basename(root) || 'app';
}

export const manifestExtractor: Extractor = {
  name: 'manifest',
  defaultConfidence: 'low',
  extract(tree): PartialIR[] {
    const partials: PartialIR[] = [];

    for (const file of tree.files) {
      const base = basename(file.relPath);
      const ecosystem =
        base === 'package.json' ? 'npm'
        : base === 'requirements.txt' ? 'pip'
        : base === 'go.mod' ? 'go'
        : base === 'pom.xml' ? 'maven'
        : null;
      if (!ecosystem) continue;

      const text = tree.read(file.relPath);
      if (!text.trim()) continue;

      const hits =
        ecosystem === 'npm' ? npmHits(text)
        : ecosystem === 'pip' ? pipHits(text)
        : ecosystem === 'go' ? goModHits(text)
        : mavenHits(text);
      if (hits.length === 0) continue; // no infra signal → skip this manifest

      const explicitName =
        ecosystem === 'npm' ? npmComponentName(text)
        : ecosystem === 'go' ? goModComponentName(text)
        : ecosystem === 'maven' ? mavenComponentName(text)
        : null;
      const componentName = explicitName ?? dirComponentName(file.relPath, tree.root);
      const componentId = scanNodeId('service', componentName);
      // A manifest directly at the scan root represents the whole scanned unit —
      // tag it so the orchestrator can unify it with another extractor's root node
      // for the same scan (see merge-draft.ts unifyScanRoots). A manifest nested in
      // a subdirectory (a monorepo package) is its own component, not the root.
      const isRootManifest = dirname(file.relPath) === '.';

      const nodes: Record<string, unknown>[] = [];
      const edges: Record<string, unknown>[] = [];
      const seenInfra = new Set<string>();

      // Component node — provenance points at the manifest itself.
      nodes.push(
        withProvenance(
          {
            id: componentId,
            type: 'service',
            name: componentName,
            config: { manifest: base, ...(isRootManifest ? { scanRoot: true } : {}) },
          },
          provenanceEntry('manifest', file.relPath, 1, 'low'),
        ),
      );

      for (const hit of hits) {
        const infraId = scanNodeId(hit.target.type, hit.target.name);
        const prov = provenanceEntry('manifest', file.relPath, hit.line, 'low');

        if (!seenInfra.has(infraId)) {
          seenInfra.add(infraId);
          nodes.push(
            withProvenance(
              {
                id: infraId,
                type: hit.target.type,
                name: hit.target.name,
                config: { inferredFromLibrary: hit.lib },
              },
              prov,
            ),
          );
        }

        edges.push(
          withProvenance(
            {
              id: `e_${componentId}_${infraId}`,
              from: componentId,
              to: infraId,
              metadata: {
                relation: hit.target.relation,
                protocol: hit.target.protocol,
                async: hit.target.async,
              },
            },
            prov,
          ),
        );
      }

      partials.push({ extractor: 'manifest', nodes, edges, warnings: [] });
    }

    return partials;
  },
};
