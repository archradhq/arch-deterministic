/**
 * Source-code → IR reconstruction orchestrator.
 * Walks a codebase, runs language-specific analyzers, and emits a canonical IR graph.
 */

import { basename, resolve } from 'node:path';
import type { DetectedArtifact, Language, ReconstructOptions, ReconstructResult } from './types.js';
import { walkFiles } from './file-walker.js';
import { detectLanguage } from './language-detect.js';
import { analyzeNodejsFile } from './nodejs.js';
import { analyzePythonFile } from './python.js';
import { analyzeCsharpFile } from './csharp.js';
import { pathFromRouteDetail } from './scan-utils.js';

const EXTENSIONS: Record<Language, string[]> = {
  nodejs: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  csharp: ['.cs'],
};

function slugId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 48) || 'svc';
}

/** Map detected DB detail string to a canonical IR node type. */
function dbNodeType(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes('→ cache') || d.includes('redis') || d.includes('memcached')) return 'cache';
  if (d.includes('→ mysql') || d.includes('mysql')) return 'mysql';
  if (d.includes('→ mongodb') || d.includes('mongo')) return 'mongodb';
  if (d.includes('→ cassandra') || d.includes('cassandra')) return 'cassandra';
  if (d.includes('→ sqlserver') || d.includes('sql server')) return 'sqlserver';
  if (d.includes('→ search') || d.includes('elastic') || d.includes('opensearch')) return 'search';
  if (d.includes('→ smtp') || d.includes('mail')) return 'smtp';
  return 'postgres';
}

function buildIrFromArtifacts(
  serviceName: string,
  serviceId: string,
  artifacts: DetectedArtifact[],
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let edgeCounter = 0;

  // Derive primary service node type from artifacts
  const hasHttpRoutes = artifacts.some((a) => a.kind === 'http_route' || a.kind === 'health_route');
  const primaryType = hasHttpRoutes ? 'gateway' : 'service';

  // Health route → populate config.url from the first detected health path
  const healthRoute = artifacts.find((a) => a.kind === 'health_route');
  const healthUrl = healthRoute ? pathFromRouteDetail(healthRoute.detail) : undefined;

  const primaryConfig: Record<string, unknown> = {
    source: 'reconstructed',
  };
  if (healthUrl) primaryConfig.url = healthUrl;

  nodes.push({
    id: serviceId,
    type: primaryType,
    name: serviceName,
    config: primaryConfig,
  });

  // DB connection nodes — one per unique type
  const seenDbTypes = new Map<string, string>(); // dbType → nodeId
  for (const a of artifacts) {
    if (a.kind !== 'db_connection') continue;
    const t = dbNodeType(a.detail);
    if (seenDbTypes.has(t)) continue;
    const dbId = `db_${t}_${slugId(a.detail)}`.slice(0, 48);
    seenDbTypes.set(t, dbId);
    nodes.push({ id: dbId, type: t, name: a.detail.split('→')[0]?.trim() ?? t });

    const eId = `e_${serviceId}_${dbId}_${edgeCounter++}`;
    edges.push({
      id: eId,
      from: serviceId,
      to: dbId,
      metadata: { relation: 'dbConnection', protocol: 'tcp', async: false },
    });
  }

  // Auth node — one per codebase if any auth artifact found
  const authArtifacts = artifacts.filter((a) => a.kind === 'auth_middleware');
  if (authArtifacts.length > 0) {
    const authId = `auth_${serviceId}`;
    nodes.push({
      id: authId,
      type: 'auth',
      name: authArtifacts[0]?.detail ?? 'Auth Middleware',
    });
    edges.push({
      id: `e_${serviceId}_${authId}_${edgeCounter++}`,
      from: serviceId,
      to: authId,
      metadata: { relation: 'authMiddleware', protocol: 'http', async: false },
    });
  }

  // Service-call nodes — one generic downstream node if HTTP client detected
  if (artifacts.some((a) => a.kind === 'service_call')) {
    const extId = `svc_ext_${serviceId}`;
    nodes.push({
      id: extId,
      type: 'service',
      name: 'External service (reconstructed)',
      config: { source: 'reconstructed', note: 'HTTP/gRPC outbound call detected' },
    });
    edges.push({
      id: `e_${serviceId}_${extId}_${edgeCounter++}`,
      from: serviceId,
      to: extId,
      metadata: { relation: 'serviceCall', protocol: 'http', async: false },
    });
  }

  return { nodes, edges };
}

export async function reconstructIrFromCodebase(
  opts: ReconstructOptions,
): Promise<ReconstructResult> {
  const rootDir = resolve(opts.from);
  const serviceName = basename(rootDir);
  const serviceId = `svc_${slugId(serviceName)}`;

  const lang: Language =
    opts.language && opts.language !== 'auto'
      ? opts.language
      : await detectLanguage(rootDir);

  const exts = EXTENSIONS[lang];
  const files = await walkFiles(rootDir, exts, opts.exclude);

  const artifacts: DetectedArtifact[] = [];
  const warnings: string[] = [];

  for (const f of files) {
    try {
      let found: DetectedArtifact[] = [];
      if (lang === 'nodejs') found = analyzeNodejsFile(f);
      else if (lang === 'python') found = analyzePythonFile(f);
      else if (lang === 'csharp') found = analyzeCsharpFile(f);
      artifacts.push(...found);
    } catch (e) {
      warnings.push(`Failed to analyze ${f.relPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (files.length === 0) {
    warnings.push(
      `No ${lang} files found in ${rootDir}. Check --language and --codebase-exclude flags.`,
    );
  }

  const { nodes, edges } = buildIrFromArtifacts(serviceName, serviceId, artifacts);

  const ir: Record<string, unknown> = {
    graph: {
      metadata: {
        name: serviceName,
        description: `IR reconstructed from ${lang} codebase at ${rootDir}`,
        provenance: { source: 'reconstruction', language: lang, files: files.length },
      },
      nodes,
      edges,
    },
  };

  return { ir, language: lang, serviceName, artifacts, warnings };
}
