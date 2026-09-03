/**
 * Manifest extractor: package.json / requirements.txt / pyproject.toml / go.mod
 * / pom.xml → PartialIR (confidence: low).
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

/**
 * The body of a TOML table, from its header to the next table header.
 *
 * A targeted reader rather than a TOML parse, matching how pom.xml is handled in
 * this file: we need three specific tables, not the language. `[project]` stops
 * at `[project.urls]` because any `[` at column zero ends the table — which is
 * what TOML means, and what keeps `dependencies` from leaking across sections.
 */
function tomlTable(text: string, header: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    // A table ends at the next header. Matched on the whole line rather than a
    // leading bracket, so an array element or an inline table cannot end it.
    if (trimmed.startsWith('[') && trimmed.endsWith(']') && !trimmed.includes('"')) break;
    body.push(lines[i]!);
  }
  return body.join('\n');
}

/**
 * Every string in every `key = [ ... ]` array in a TOML table body.
 *
 * Bracket matching has to be quote-aware: a requirement may carry extras, and
 * `"fastapi[standard]>=0.141.1"` closes a naive non-greedy `\[...\]` match
 * halfway through the first dependency, which silently yielded nothing at all.
 * Only quotes are tracked, since a requirement string cannot contain a newline
 * and TOML's multi-line strings do not appear in dependency arrays.
 */
function tomlArrayStrings(body: string): string[] {
  const out: string[] = [];
  for (const start of body.matchAll(/(?:^|\n)[ \t]*[A-Za-z0-9_.-]+[ \t]*=[ \t]*\[/g)) {
    let depth = 1;
    let quote: string | null = null;
    let buf = '';
    for (let i = start.index + start[0].length; i < body.length && depth > 0; i++) {
      const ch = body[i]!;
      if (quote) {
        if (ch === quote) {
          if (buf) out.push(buf);
          buf = '';
          quote = null;
        } else buf += ch;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }
  }
  return out;
}

/**
 * Parse pyproject.toml into recognized infra hits.
 *
 * `requirements.txt` was the only Python manifest we read, and neither Python
 * repository in the corpus has one — PEP 621 `pyproject.toml` is the standard
 * now. full-stack-fastapi-template sat in the corpus passing green while its
 * `psycopg` dependency went unread.
 *
 * Runtime dependencies only: `[project] dependencies` and its optional extras,
 * or Poetry's equivalent. Deliberately NOT `[dependency-groups]` or Poetry's dev
 * groups — those are test and tooling requirements, and a project that pulls in
 * a database driver to run its test suite is not thereby depending on a
 * database.
 */
function pyprojectHits(text: string): Hit[] {
  const requirements: string[] = [];

  const project = tomlTable(text, 'project');
  if (project) requirements.push(...tomlArrayStrings(project));
  const extras = tomlTable(text, 'project.optional-dependencies');
  if (extras) requirements.push(...tomlArrayStrings(extras));

  // Poetry states dependencies as table keys (`redis = "^5.0"`), not as strings.
  for (const header of ['tool.poetry.dependencies', 'tool.poetry.dev-dependencies']) {
    const body = tomlTable(text, header);
    if (!body) continue;
    for (const line of body.split(/\r?\n/)) {
      const key = line.replace(/#.*$/, '').trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (key?.[1] && key[1].toLowerCase() !== 'python') requirements.push(key[1]);
    }
  }

  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const req of requirements) {
    // parseRequirementLine stops at the first non-name character, so the extras
    // and specifiers in `psycopg[binary]>=3.3.4,<4` reduce to `psycopg`.
    const name = parseRequirementLine(req);
    if (!name || seen.has(name)) continue;
    const target = PIP_LIB_MAP[name];
    if (!target) continue;
    seen.add(name);
    hits.push({ lib: name, target, line: lineOf(text, req) });
  }
  return hits;
}

/** Component name from pyproject.toml's `[project] name` (or Poetry's). */
function pyprojectComponentName(text: string): string | null {
  for (const header of ['project', 'tool.poetry']) {
    const body = tomlTable(text, header);
    const m = body?.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
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
  const segments = m[1]!.split('/').filter(Boolean);
  // Go encodes major versions from v2 onward in the module path itself:
  // `module github.com/argoproj/argo-cd/v3`. The last segment is then the
  // version, not the module, and naming from it produced a component called
  // "v3". Anything at v0/v1 has no such suffix and is unaffected.
  while (segments.length > 1 && /^v\d+$/.test(segments[segments.length - 1]!)) {
    segments.pop();
  }
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
 *
 * Both lookups are confined to the project's own header, before `<dependencies>`
 * and with artifact-repository blocks removed. `<repository>` carries a `<name>`
 * too — `<name>Spring Milestones</name>` is where Maven fetches jars from, not a
 * component — and a pom with no `<name>` of its own would otherwise be named
 * after it.
 */
/**
 * Remove literal XML regions in one linear pass per region type.
 *
 * A separating space is retained so removing a region cannot join attacker-
 * controlled fragments into a new XML comment or tag boundary.
 */
function withoutXmlRegions(text: string, open: string, close: string): string {
  let cursor = 0;
  const result: string[] = [];
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start === -1) {
      result.push(text.slice(cursor));
      break;
    }
    result.push(text.slice(cursor, start), ' ');
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    cursor = end + close.length;
  }
  return result.join('');
}

export function mavenComponentName(text: string): string | null {
  // Comments first: a pom that merely MENTIONS <repositories> in a comment
  // would otherwise have everything up to the real closing tag stripped.
  let header = withoutXmlRegions(text, '<!--', '-->');
  if (header.includes('<!--') || header.includes('-->')) return null;
  for (const tag of ['parent', 'pluginRepositories', 'repositories']) {
    header = withoutXmlRegions(header, `<${tag}>`, `</${tag}>`);
  }
  header = header.split('<dependencies>')[0] ?? '';
  const displayName = header.match(/<name>([^<]+)<\/name>/)?.[1]?.trim();
  if (displayName && !displayName.includes('${')) return displayName;
  return header.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim() || null;
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
        : base === 'pyproject.toml' ? 'pyproject'
        : base === 'go.mod' ? 'go'
        : base === 'pom.xml' ? 'maven'
        : null;
      if (!ecosystem) continue;

      const text = tree.read(file.relPath);
      if (!text.trim()) continue;

      const hits =
        ecosystem === 'npm' ? npmHits(text)
        : ecosystem === 'pip' ? pipHits(text)
        : ecosystem === 'pyproject' ? pyprojectHits(text)
        : ecosystem === 'go' ? goModHits(text)
        : mavenHits(text);
      if (hits.length === 0) continue; // no infra signal → skip this manifest

      const explicitName =
        ecosystem === 'npm' ? npmComponentName(text)
        : ecosystem === 'pyproject' ? pyprojectComponentName(text)
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
