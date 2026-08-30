/**
 * Source-code → IR reconstruction orchestrator.
 * Walks a codebase, runs language-specific analyzers, and emits a canonical IR graph
 * with multiple service nodes — one per detected service boundary.
 */

import { basename, extname, resolve } from 'node:path';
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
export function dbNodeType(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes('→ cache') || d.includes('redis') || d.includes('memcached') || d.includes('bullmq')) return 'cache';
  if (d.includes('→ mysql') || d.includes('mysql')) return 'mysql';
  if (d.includes('→ mongodb') || d.includes('mongo')) return 'mongodb';
  if (d.includes('→ cassandra') || d.includes('cassandra')) return 'cassandra';
  if (d.includes('→ sqlserver') || d.includes('sql server')) return 'sqlserver';
  if (d.includes('→ search') || d.includes('elastic') || d.includes('opensearch')) return 'search';
  if (d.includes('→ smtp') || d.includes('mail')) return 'smtp';
  if (d.includes('→ firestore') || d.includes('firebase') || d.includes('firestore')) return 'firestore';
  return 'postgres';
}

/**
 * Derive a human-readable node name from a db_connection artifact.
 * Priority: env var name > connection variable name > library detail.
 */
function dbNodeName(artifact: DetectedArtifact): string {
  if (artifact.connectionName) {
    // env var like "SESSION_REDIS_URL" → "session-redis"
    return artifact.connectionName
      .toLowerCase()
      .replace(/_(?:url|host|uri|port|connection_string)$/i, '')
      .replace(/_/g, '-');
  }
  // Fall back to the detail before the " → " separator
  return artifact.detail.split('→')[0]?.trim() ?? dbNodeType(artifact.detail);
}

// ---- Service boundary detection --------------------------------------------

/**
 * Returns true if a relative file path is a dedicated route/controller file
 * (as opposed to a monolithic entry file or shared utility).
 */
function isRouteBoundaryFile(relPath: string, artifacts: DetectedArtifact[]): boolean {
  const norm = relPath.replace(/\\/g, '/');
  // Files inside a routes/ controllers/ handlers/ endpoints/ directory
  if (/(?:^|\/)(routes?|controllers?|handlers?|endpoints?|resources?)\//i.test(norm)) return true;
  // NestJS convention: *.controller.ts/js
  if (/\.controller\.[jt]sx?$/i.test(norm)) return true;
  // Files where NestJS route artifacts appear (@Get, @Post, etc.)
  if (artifacts.some((a) => a.kind === 'http_route' && /^@/.test(a.detail))) return true;
  return false;
}

type ServiceGroup = {
  id: string;
  name: string;
  /** 'gateway' = HTTP entry; 'service' = route handler; 'worker' = background job */
  nodeType: 'gateway' | 'service' | 'worker';
  artifacts: DetectedArtifact[];
};

/**
 * Group per-file artifacts into service groups.
 *
 * Multi-service layout (route files in routes/ or *.controller.ts):
 *   - Entry file(s) with app.listen() → one gateway node
 *   - Each route boundary file → one service node
 *   - Each worker file → one worker node
 *
 * Monolithic layout (no dedicated route directory):
 *   - All artifacts → single gateway or service node
 */
function groupIntoServices(
  fileArtifacts: Map<string, DetectedArtifact[]>,
  rootServiceName: string,
  singleService = false,
): ServiceGroup[] {
  const entryFiles: string[] = [];
  const routeFiles: string[] = [];
  const workerFiles: string[] = [];

  for (const [relPath, artifacts] of fileArtifacts) {
    const hasEntry = artifacts.some((a) => a.kind === 'app_entry');
    const hasWorker = artifacts.some((a) => a.kind === 'worker_definition');
    const hasRoutes = artifacts.some((a) => a.kind === 'http_route' || a.kind === 'health_route');

    if (hasEntry) entryFiles.push(relPath);
    if (hasWorker && !hasEntry) workerFiles.push(relPath);
    if (hasRoutes && isRouteBoundaryFile(relPath, artifacts)) routeFiles.push(relPath);
  }

  const groups: ServiceGroup[] = [];

  // ----- Multi-service decomposition -----
  if (!singleService && (routeFiles.length >= 2 || (routeFiles.length >= 1 && entryFiles.length >= 1))) {
    // Gateway node — merge all entry file artifacts
    const gatewayArtifacts = entryFiles.flatMap((f) => fileArtifacts.get(f) ?? []);
    const gatewayId = `gw_${slugId(rootServiceName)}`;
    groups.push({
      id: gatewayId,
      name: rootServiceName,
      nodeType: 'gateway',
      artifacts: gatewayArtifacts,
    });

    // One service node per route boundary file
    const seenIds = new Set<string>([gatewayId]);
    for (const relPath of routeFiles) {
      const svcName = basename(relPath, extname(relPath));
      let svcId = `svc_${slugId(svcName)}`;
      // Deduplicate ids (two files could produce same slug)
      let suffix = 2;
      while (seenIds.has(svcId)) {
        svcId = `svc_${slugId(svcName)}_${suffix++}`;
      }
      seenIds.add(svcId);
      groups.push({
        id: svcId,
        name: svcName,
        nodeType: 'service',
        artifacts: fileArtifacts.get(relPath) ?? [],
      });
    }

    // Worker nodes
    for (const relPath of workerFiles) {
      const workerName = basename(relPath, extname(relPath));
      let wId = `worker_${slugId(workerName)}`;
      let suffix = 2;
      while (seenIds.has(wId)) {
        wId = `worker_${slugId(workerName)}_${suffix++}`;
      }
      seenIds.add(wId);
      groups.push({
        id: wId,
        name: workerName,
        nodeType: 'worker',
        artifacts: fileArtifacts.get(relPath) ?? [],
      });
    }

    return groups;
  }

  // ----- Single-service fallback -----
  // All artifacts in one node (monolithic layout or no recognized route structure)
  const allArtifacts = [...fileArtifacts.values()].flat();
  const hasHttpRoutes = allArtifacts.some((a) => a.kind === 'http_route' || a.kind === 'health_route');
  groups.push({
    id: `svc_${slugId(rootServiceName)}`,
    name: rootServiceName,
    nodeType: hasHttpRoutes ? 'gateway' : 'service',
    artifacts: allArtifacts,
  });

  // Add worker nodes even in single-service mode
  for (const relPath of workerFiles) {
    const workerName = basename(relPath, extname(relPath));
    groups.push({
      id: `worker_${slugId(workerName)}`,
      name: workerName,
      nodeType: 'worker',
      artifacts: fileArtifacts.get(relPath) ?? [],
    });
  }

  return groups;
}

// ---- IR graph construction -------------------------------------------------

function buildIrFromGroups(
  groups: ServiceGroup[],
  rootServiceName: string,
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let edgeCounter = 0;

  // Shared DB nodes — keyed by dbType so the same database isn't duplicated across services
  const sharedDbNodes = new Map<string, { nodeId: string; name: string }>(); // dbType → {nodeId, name}

  // Shared external service nodes — keyed by destination label
  const sharedExtNodes = new Map<string, string>(); // destination → nodeId

  // Auth nodes — one per primary service
  const authNodes = new Map<string, string>(); // serviceId → authNodeId

  // Single shared generic external node (for service_call with no detected URL)
  let genericExtNodeId: string | undefined;

  const gatewayGroup = groups.find((g) => g.nodeType === 'gateway');
  const serviceGroups = groups.filter((g) => g.nodeType === 'service');

  for (const group of groups) {
    const primaryConfig: Record<string, unknown> = { source: 'reconstructed' };

    // Attach health check URL to gateway/service node if a health route is present
    if (group.nodeType !== 'worker') {
      const healthRoute = group.artifacts.find((a) => a.kind === 'health_route');
      if (healthRoute) {
        const healthUrl = pathFromRouteDetail(healthRoute.detail);
        if (healthUrl) primaryConfig.url = healthUrl;
      }
    }

    nodes.push({
      id: group.id,
      type: group.nodeType,
      name: group.name,
      config: primaryConfig,
    });
  }

  // Gateway → service edges (when decomposed)
  if (gatewayGroup && serviceGroups.length > 0) {
    for (const svc of serviceGroups) {
      edges.push({
        id: `e_${gatewayGroup.id}_${svc.id}_${edgeCounter++}`,
        from: gatewayGroup.id,
        to: svc.id,
        metadata: { relation: 'routes', protocol: 'http', async: false },
      });
    }
  }

  // Per-group DB, auth, and external edges
  for (const group of groups) {
    // DB connections
    const seenDbTypesForGroup = new Set<string>();
    for (const a of group.artifacts) {
      if (a.kind !== 'db_connection') continue;
      const t = dbNodeType(a.detail);
      if (seenDbTypesForGroup.has(t)) continue;
      seenDbTypesForGroup.add(t);

      // Create shared DB node on first encounter; upgrade name if a better one arrives later
      if (!sharedDbNodes.has(t)) {
        const dbId = `db_${t}_${slugId(rootServiceName)}`.slice(0, 48);
        const dbName = dbNodeName(a);
        sharedDbNodes.set(t, { nodeId: dbId, name: dbName });
        nodes.push({ id: dbId, type: t, name: dbName });
      } else if (a.connectionName) {
        // Upgrade to a user-recognizable name (env var or variable name) if available
        const entry = sharedDbNodes.get(t)!;
        const betterName = dbNodeName(a);
        if (entry.name !== betterName) {
          entry.name = betterName;
          const node = nodes.find((n) => n.id === entry.nodeId);
          if (node) node.name = betterName;
        }
      }

      const { nodeId: dbId } = sharedDbNodes.get(t)!;
      edges.push({
        id: `e_${group.id}_${dbId}_${edgeCounter++}`,
        from: group.id,
        to: dbId,
        metadata: { relation: 'dbConnection', protocol: 'tcp', async: false },
      });
    }

    // Auth node
    const authArtifacts = group.artifacts.filter((a) => a.kind === 'auth_middleware');
    if (authArtifacts.length > 0 && !authNodes.has(group.id)) {
      const authId = `auth_${group.id}`;
      authNodes.set(group.id, authId);
      nodes.push({
        id: authId,
        type: 'auth',
        name: authArtifacts[0]?.detail ?? 'Auth Middleware',
      });
      edges.push({
        id: `e_${group.id}_${authId}_${edgeCounter++}`,
        from: group.id,
        to: authId,
        metadata: { relation: 'authMiddleware', protocol: 'http', async: false },
      });
    }

    // External HTTP nodes — one per distinct destination
    for (const a of group.artifacts) {
      if (a.kind !== 'external_http') continue;
      const dest = a.destination ?? 'external';
      if (sharedExtNodes.has(dest)) {
        // Edge already exists between this group and the ext node? Check.
        const extId = sharedExtNodes.get(dest)!;
        const alreadyEdged = edges.some((e) => e.from === group.id && e.to === extId);
        if (!alreadyEdged) {
          edges.push({
            id: `e_${group.id}_${extId}_${edgeCounter++}`,
            from: group.id,
            to: extId,
            metadata: { relation: 'serviceCall', protocol: 'http', async: false },
          });
        }
        continue;
      }
      const extId = `ext_${slugId(dest)}`;
      sharedExtNodes.set(dest, extId);
      nodes.push({
        id: extId,
        type: 'service',
        name: dest,
        config: { source: 'reconstructed', external: true, note: `External: ${a.detail}` },
      });
      edges.push({
        id: `e_${group.id}_${extId}_${edgeCounter++}`,
        from: group.id,
        to: extId,
        metadata: { relation: 'serviceCall', protocol: 'http', async: false },
      });
    }

    // Generic service-call node — one shared node for all groups without a specific destination
    const hasSpecificExternal = group.artifacts.some((a) => a.kind === 'external_http');
    if (!hasSpecificExternal && group.artifacts.some((a) => a.kind === 'service_call')) {
      if (!genericExtNodeId) {
        genericExtNodeId = `svc_ext_generic`;
        nodes.push({
          id: genericExtNodeId,
          type: 'service',
          name: 'external-service',
          config: { source: 'reconstructed', external: true, note: 'HTTP/gRPC outbound call detected' },
        });
      }
      const alreadyEdged = edges.some((e) => e.from === group.id && e.to === genericExtNodeId);
      if (!alreadyEdged) {
        edges.push({
          id: `e_${group.id}_${genericExtNodeId}_${edgeCounter++}`,
          from: group.id,
          to: genericExtNodeId,
          metadata: { relation: 'serviceCall', protocol: 'http', async: false },
        });
      }
    }
  }

  return { nodes, edges };
}

// ---- public API ------------------------------------------------------------

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

  const fileArtifacts = new Map<string, DetectedArtifact[]>();
  const allArtifacts: DetectedArtifact[] = [];
  const warnings: string[] = [];

  for (const f of files) {
    try {
      let found: DetectedArtifact[] = [];
      if (lang === 'nodejs') found = analyzeNodejsFile(f);
      else if (lang === 'python') found = analyzePythonFile(f);
      else if (lang === 'csharp') found = analyzeCsharpFile(f);
      fileArtifacts.set(f.relPath, found);
      allArtifacts.push(...found);
    } catch (e) {
      warnings.push(`Failed to analyze ${f.relPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (files.length === 0) {
    warnings.push(
      `No ${lang} files found in ${rootDir}. Check --language and --codebase-exclude flags.`,
    );
  }

  let nodes: Record<string, unknown>[];
  let edges: Record<string, unknown>[];

  if (lang === 'nodejs') {
    const groups = groupIntoServices(fileArtifacts, serviceName, opts.singleService);
    ({ nodes, edges } = buildIrFromGroups(groups, serviceName));
  } else {
    // Python / C# use the legacy single-service builder
    ({ nodes, edges } = buildLegacyIr(serviceName, serviceId, allArtifacts));
  }

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

  return { ir, language: lang, serviceName, artifacts: allArtifacts, warnings };
}

// ---- legacy single-service builder (Python / C#) ---------------------------

function buildLegacyIr(
  serviceName: string,
  serviceId: string,
  artifacts: DetectedArtifact[],
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  let edgeCounter = 0;

  const hasHttpRoutes = artifacts.some((a) => a.kind === 'http_route' || a.kind === 'health_route');
  const primaryType = hasHttpRoutes ? 'gateway' : 'service';

  const healthRoute = artifacts.find((a) => a.kind === 'health_route');
  const healthUrl = healthRoute ? pathFromRouteDetail(healthRoute.detail) : undefined;

  const primaryConfig: Record<string, unknown> = { source: 'reconstructed' };
  if (healthUrl) primaryConfig.url = healthUrl;

  nodes.push({ id: serviceId, type: primaryType, name: serviceName, config: primaryConfig });

  const seenDbTypes = new Map<string, string>();
  for (const a of artifacts) {
    if (a.kind !== 'db_connection') continue;
    const t = dbNodeType(a.detail);
    if (seenDbTypes.has(t)) continue;
    const dbId = `db_${t}_${slugId(a.detail)}`.slice(0, 48);
    seenDbTypes.set(t, dbId);
    nodes.push({ id: dbId, type: t, name: dbNodeName(a) });
    edges.push({
      id: `e_${serviceId}_${dbId}_${edgeCounter++}`,
      from: serviceId,
      to: dbId,
      metadata: { relation: 'dbConnection', protocol: 'tcp', async: false },
    });
  }

  const authArtifacts = artifacts.filter((a) => a.kind === 'auth_middleware');
  if (authArtifacts.length > 0) {
    const authId = `auth_${serviceId}`;
    nodes.push({ id: authId, type: 'auth', name: authArtifacts[0]?.detail ?? 'Auth Middleware' });
    edges.push({
      id: `e_${serviceId}_${authId}_${edgeCounter++}`,
      from: serviceId,
      to: authId,
      metadata: { relation: 'authMiddleware', protocol: 'http', async: false },
    });
  }

  // External destinations from external_http artifacts
  const seenDest = new Set<string>();
  for (const a of artifacts) {
    if (a.kind !== 'external_http') continue;
    const dest = a.destination ?? 'external';
    if (seenDest.has(dest)) continue;
    seenDest.add(dest);
    const extId = `ext_${slugId(dest)}`;
    nodes.push({
      id: extId,
      type: 'service',
      name: dest,
      config: { source: 'reconstructed', external: true, note: `External: ${a.detail}` },
    });
    edges.push({
      id: `e_${serviceId}_${extId}_${edgeCounter++}`,
      from: serviceId,
      to: extId,
      metadata: { relation: 'serviceCall', protocol: 'http', async: false },
    });
  }

  // Fallback generic external node
  if (seenDest.size === 0 && artifacts.some((a) => a.kind === 'service_call')) {
    const extId = `svc_ext_${serviceId}`;
    nodes.push({
      id: extId,
      type: 'service',
      name: 'external-service',
      config: { source: 'reconstructed', external: true, note: 'HTTP/gRPC outbound call detected' },
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
