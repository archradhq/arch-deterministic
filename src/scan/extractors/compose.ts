/**
 * Topology extractor: Docker Compose → PartialIR (confidence: high).
 *
 * Reuses the tested `dockerComposeToCanonicalIr()` converter from the `init`
 * command path, then (a) canonicalizes node ids via {@link canonicalizeIds} so
 * other extractors can agree on shared components, and (b) attaches per-service
 * provenance with the real line number of the service key.
 */

import { basename, dirname } from 'node:path';
import yaml from 'js-yaml';
import type { Extractor, PartialIR } from '../types.js';
import { canonicalizeIds } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import {
  dockerComposeToCanonicalIr,
  DockerComposeInitError,
} from '../../init/docker-compose.js';

const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml(?:\.tmpl(?:\.[\w-]+)?)?$/i;
const BASE_COMPOSE_FILE = /^(docker-)?compose\.ya?ml$/i;

/** True for conventional Compose files and Compose-specific YAML templates. */
export function isComposeFile(relPath: string): boolean {
  return COMPOSE_FILE.test(basename(relPath));
}

type ComposeObject = Record<string, unknown>;
type ComposeTaggedValue = { __archradComposeTag: 'reset' | 'override'; value: unknown };

const YAML_MERGE_TYPE = (yaml as unknown as {
  types: { merge: InstanceType<typeof yaml.Type> };
}).types.merge;

const COMPOSE_MERGE_SCHEMA = yaml.JSON_SCHEMA.extend({
  implicit: [YAML_MERGE_TYPE],
  explicit: [
    ...(['scalar', 'sequence', 'mapping'] as const).flatMap((kind) =>
    (['reset', 'override'] as const).map(
      (tag) => new yaml.Type(`!${tag}`, {
        kind,
        construct: (value: unknown): ComposeTaggedValue => ({ __archradComposeTag: tag, value }),
      }),
    ),
    ),
  ],
});

function isObject(value: unknown): value is ComposeObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTaggedValue(value: unknown): value is ComposeTaggedValue {
  return isObject(value) &&
    (value.__archradComposeTag === 'reset' || value.__archradComposeTag === 'override') &&
    Object.prototype.hasOwnProperty.call(value, 'value');
}

function unwrapComposeTags(value: unknown): unknown {
  if (isTaggedValue(value)) return unwrapComposeTags(value.value);
  if (Array.isArray(value)) return value.map(unwrapComposeTags);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapComposeTags(child)]));
  }
  return value;
}

/** Compose mappings merge recursively; scalar lists append while command-like lists replace. */
function mergeComposeValue(base: unknown, override: unknown, path: string[] = []): unknown {
  if (isTaggedValue(override)) return unwrapComposeTags(override.value);
  if (override === null) return null;
  if (isObject(base) && isObject(override)) {
    const out: ComposeObject = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = key in base
        ? mergeComposeValue(base[key], override[key], [...path, key])
        : override[key];
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(override)) {
    const leaf = path[path.length - 1]?.toLowerCase();
    if (leaf === 'command' || leaf === 'entrypoint' || leaf === 'test') return [...override];
    const combined = [...base, ...override];
    return combined.filter((value, index) =>
      typeof value === 'string' ? combined.indexOf(value) === index : true,
    );
  }
  return override;
}

/** Parse and merge a canonical Compose base with its automatic `.override` file. */
export function mergeComposeDocuments(baseText: string, overrideText: string): string {
  const base = yaml.load(baseText, { schema: COMPOSE_MERGE_SCHEMA });
  const override = yaml.load(overrideText, { schema: COMPOSE_MERGE_SCHEMA });
  if (!isObject(base) || !isObject(override)) {
    throw new DockerComposeInitError('Compose base and override must be YAML mappings');
  }
  return yaml.dump(unwrapComposeTags(mergeComposeValue(base, override)), { noRefs: true, lineWidth: -1, sortKeys: false });
}

function automaticOverrideFor(relPath: string, composePaths: Set<string>): string | undefined {
  const name = basename(relPath);
  const match = name.match(BASE_COMPOSE_FILE);
  if (!match) return undefined;
  const prefix = match[1] ?? '';
  const dir = dirname(relPath).replace(/\\/g, '/');
  for (const ext of ['yaml', 'yml']) {
    const candidate = `${dir === '.' ? '' : `${dir}/`}${prefix}compose.override.${ext}`;
    if (composePaths.has(candidate)) return candidate;
  }
  return undefined;
}

function namedVariantBaseFor(relPath: string, composePaths: Set<string>): string | undefined {
  const name = basename(relPath);
  const match = name.match(/^(docker-)?compose\.[\w-]+\.ya?ml$/i);
  if (!match || /\.override\.ya?ml$/i.test(name)) return undefined;
  const prefix = match[1] ?? '';
  const dir = dirname(relPath).replace(/\\/g, '/');
  for (const ext of ['yaml', 'yml']) {
    const candidate = `${dir === '.' ? '' : `${dir}/`}${prefix}compose.${ext}`;
    if (composePaths.has(candidate)) return candidate;
  }
  return undefined;
}

function composeServices(text: string): ComposeObject | undefined {
  try {
    const parsed = yaml.load(text, { schema: COMPOSE_MERGE_SCHEMA });
    if (!isObject(parsed) || !isObject(parsed.services)) return undefined;
    return parsed.services;
  } catch {
    return undefined;
  }
}

function isCommentOnlyCompose(text: string): boolean {
  try {
    return yaml.load(text, { schema: COMPOSE_MERGE_SCHEMA }) == null;
  } catch {
    return false;
  }
}

/** A named sibling is an overlay only with objective cross-file evidence. */
function isNamedVariantOverlay(baseText: string, variantText: string): boolean {
  const base = composeServices(baseText);
  const variant = composeServices(variantText);
  if (!base || !variant || Object.keys(variant).length === 0) return false;
  const baseNames = new Set(Object.keys(base));
  if (Object.keys(variant).some((name) => baseNames.has(name))) return true;
  for (const raw of Object.values(variant)) {
    if (!isObject(raw)) continue;
    const depends = raw.depends_on;
    const names = Array.isArray(depends)
      ? depends.filter((value): value is string => typeof value === 'string')
      : isObject(depends) ? Object.keys(depends) : [];
    if (names.some((name) => baseNames.has(name) && !(name in variant))) return true;
  }
  return false;
}

/**
 * Map each service name to the 1-based line of its key in the compose file.
 * Best-effort: falls back to line 1 for names not located.
 */
export function serviceLineIndex(text: string, names: Set<string>): Map<string, number> {
  const lines = text.split(/\r?\n/);
  const map = new Map<string, number>();
  let inServices = false;
  let baseIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (!inServices) {
      if (/^\s*services\s*:\s*$/.test(line)) {
        inServices = true;
        baseIndent = -1;
      }
      continue;
    }
    const km = line.match(/^(\s*)([A-Za-z0-9._-]+)\s*:/);
    if (!km) continue;
    const indent = km[1]!.length;
    const key = km[2]!;
    if (indent === 0) {
      // A new top-level block ends the services mapping.
      inServices = false;
      continue;
    }
    if (baseIndent === -1) baseIndent = indent;
    if (indent === baseIndent && names.has(key) && !map.has(key)) {
      map.set(key, i + 1);
    }
  }
  return map;
}

/**
 * Tag a compose service as the scan root when it is built from the repository
 * root itself, so `unifyScanRoots` merges it with the code/manifest tiers' view
 * of the same application.
 *
 * Deliberately strict on both axes, because a wrong merge silently fabricates
 * architecture:
 *  - the compose file must sit at the repo root (a nested `result/compose.yml`
 *    describes a sub-component, not the repo);
 *  - the build context must be that same root (`build: .`). `build: ./tests/`
 *    is a sibling component — a test harness or migration job — not the app.
 *
 * A service pulled via `image:` never qualifies: it may be any third-party
 * component, which is what keeps compose+manifest fixtures from over-merging.
 */
function tagScanRootIfBuiltFromRoot(
  node: Record<string, unknown>,
  composeFileRelPath: string,
  allowScanRoot: boolean,
): Record<string, unknown> {
  if (!allowScanRoot) return node;
  const isRootComposeFile = !composeFileRelPath.includes('/');
  if (!isRootComposeFile) return node;

  const config =
    node.config && typeof node.config === 'object' && !Array.isArray(node.config)
      ? (node.config as Record<string, unknown>)
      : undefined;
  const compose =
    config?.compose && typeof config.compose === 'object' && !Array.isArray(config.compose)
      ? (config.compose as Record<string, unknown>)
      : undefined;
  if (compose?.buildContext !== '.') return node;
  return { ...node, config: { ...(config ?? {}), scanRoot: true } };
}

export const composeExtractor: Extractor = {
  name: 'compose',
  defaultConfidence: 'high',
  extract(tree): PartialIR[] {
    const partials: PartialIR[] = [];
    const composeFiles = tree.files.filter((file) => isComposeFile(file.relPath));
    const composePaths = new Set(composeFiles.map((file) => file.relPath));
    const consumedOverrides = new Set<string>();
    const pairedOverrides = new Set(
      composeFiles
        .map((file) => automaticOverrideFor(file.relPath, composePaths))
        .filter((path): path is string => !!path),
    );

    for (const file of composeFiles) {
      if (consumedOverrides.has(file.relPath) || pairedOverrides.has(file.relPath)) continue;
      const overridePath = automaticOverrideFor(file.relPath, composePaths);
      const variantBasePath = overridePath ? undefined : namedVariantBaseFor(file.relPath, composePaths);
      const fileText = tree.read(file.relPath);
      let text = fileText;
      const sourceTexts = [{ path: file.relPath, text: fileText }];
      let mergedNamedVariant = false;
      if (overridePath) {
        const overrideText = tree.read(overridePath);
        try {
          text = mergeComposeDocuments(fileText, overrideText);
          sourceTexts.push({ path: overridePath, text: overrideText });
          consumedOverrides.add(overridePath);
        } catch (e) {
          partials.push({
            extractor: 'compose', nodes: [], edges: [],
            warnings: [`${file.relPath} + ${overridePath}: ${e instanceof Error ? e.message : String(e)} — skipped`],
          });
          consumedOverrides.add(overridePath);
          continue;
        }
      } else if (variantBasePath) {
        const variantBaseText = tree.read(variantBasePath);
        if (isNamedVariantOverlay(variantBaseText, fileText)) {
          try {
            text = mergeComposeDocuments(variantBaseText, fileText);
            sourceTexts.unshift({ path: variantBasePath, text: variantBaseText });
            mergedNamedVariant = true;
          } catch (e) {
            partials.push({
              extractor: 'compose', nodes: [], edges: [],
              warnings: [`${variantBasePath} + ${file.relPath}: ${e instanceof Error ? e.message : String(e)} — skipped`],
            });
            continue;
          }
        }
      }
      if (!text.trim()) continue;
      if (isCommentOnlyCompose(text)) continue;

      let ir: Record<string, unknown>;
      const warnings: string[] = [];
      try {
        const label = overridePath ? `${file.relPath} + ${overridePath}` : file.relPath;
        const result = dockerComposeToCanonicalIr(text, { fileLabel: label });
        ir = result.ir;
        const locallyDeclared = new Set(Object.keys(composeServices(fileText) ?? {}));
        for (const w of result.report.warnings) {
          if (mergedNamedVariant) {
            const service = w.match(/^([^:]+):/)?.[1];
            if (service && !locallyDeclared.has(service) && service !== 'depends_on') continue;
          }
          warnings.push(`${file.relPath}: ${w}`);
        }
      } catch (e) {
        warnings.push(
          `${file.relPath}: ${
            e instanceof DockerComposeInitError ? e.message : String(e)
          } — skipped`,
        );
        partials.push({ extractor: 'compose', nodes: [], edges: [], warnings });
        continue;
      }

      const graph = (ir.graph ?? ir) as Record<string, unknown>;
      const rawNodes = (Array.isArray(graph.nodes) ? graph.nodes : []) as Record<string, unknown>[];
      const rawEdges = (Array.isArray(graph.edges) ? graph.edges : []) as Record<string, unknown>[];

      const names = new Set(
        rawNodes.map((n) => (typeof n.name === 'string' ? n.name : '')).filter(Boolean),
      );
      const sourceLines = sourceTexts.map((source) => ({
        ...source,
        lines: serviceLineIndex(source.text, names),
      }));
      const nameById = new Map<string, string>();
      for (const n of rawNodes) {
        if (typeof n.id === 'string' && typeof n.name === 'string') nameById.set(n.id, n.name);
      }

      const rootBuildCandidates = rawNodes.filter((node) => {
        const config = isObject(node.config) ? node.config : {};
        const compose = isObject(config.compose) ? config.compose : {};
        return compose.buildContext === '.';
      });
      // A repository may build many distinct workers from the same context. Only
      // tag a scan root when Compose identifies exactly one unambiguous app root;
      // otherwise unifyScanRoots would collapse those real services together.
      const allowScanRoot = rootBuildCandidates.length === 1;

      // Attach provenance BEFORE canonicalizing so provenance survives the id
      // remap (canonicalizeIds preserves `config`).
      const nodes = rawNodes.map((n) => {
        const name = typeof n.name === 'string' ? n.name : '';
        const tagged = tagScanRootIfBuiltFromRoot(n, file.relPath, allowScanRoot);
        let result = tagged;
        const declaredIn = sourceLines.filter((source) => source.lines.has(name));
        for (const source of declaredIn.length ? declaredIn : sourceLines.slice(0, 1)) {
          result = withProvenance(result, provenanceEntry('compose', source.path, source.lines.get(name) ?? 1, 'high'));
        }
        return result;
      });
      const edges = rawEdges.map((e) => {
        const fromName = typeof e.from === 'string' ? nameById.get(e.from) : undefined;
        let result = e;
        const declaredIn = fromName ? sourceLines.filter((source) => source.lines.has(fromName)) : [];
        for (const source of declaredIn.length ? declaredIn : sourceLines.slice(0, 1)) {
          result = withProvenance(result, provenanceEntry('compose', source.path, fromName ? source.lines.get(fromName) ?? 1 : 1, 'high'));
        }
        return result;
      });

      const canon = canonicalizeIds(nodes, edges);
      partials.push({
        extractor: 'compose',
        nodes: canon.nodes,
        edges: canon.edges,
        warnings,
      });
    }

    return partials;
  },
};
