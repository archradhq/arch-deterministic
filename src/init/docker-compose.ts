/**
 * Docker Compose → canonical IR for `archrad init --from docker-compose.yml`.
 * Deterministic mapping: services → nodes, depends_on + connection URLs → edges.
 */

import yaml from 'js-yaml';
import { stripLeadingTrailingUnderscores } from '../stringEdgeStrip.js';

export class DockerComposeInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerComposeInitError';
  }
}

export type DockerComposeInitReport = {
  services: number;
  edges: number;
  warnings: string[];
};

function slugServiceId(name: string): string {
  const t = stripLeadingTrailingUnderscores(String(name).replace(/[^a-zA-Z0-9]+/g, '_')).toLowerCase();
  return (t || 'service').slice(0, 64);
}

/** Infer node.type from Docker image reference (before tag/digest). */
export function inferTypeFromImage(imageRef: string): { type: string; warning?: string } {
  const img = String(imageRef).trim().toLowerCase();
  const base = img.split('@')[0]?.split(':')[0] ?? img;
  const last = base.includes('/') ? base.split('/').pop() ?? base : base;

  if (/postgres|mysql|mariadb|mssql|oracle|timescale|cockroach/.test(last)) {
    return { type: 'postgres' };
  }
  if (/redis|memcached|elasticache/.test(last)) {
    return { type: 'cache' };
  }
  if (/rabbitmq|kafka|nats|pulsar|sqs|sns|pubsub/.test(last)) {
    return { type: 'queue' };
  }
  if (/nginx|traefik|caddy|haproxy|kong|envoy/.test(last)) {
    return { type: 'gateway' };
  }
  if (/elasticsearch|opensearch|solr/.test(last)) {
    return { type: 'search' };
  }
  if (/minio|localstack/.test(last)) {
    return { type: 'storage' };
  }
  return {
    type: 'service',
    warning: `Unknown image "${imageRef}" — defaulting node type to "service"`,
  };
}

function normalizeDependsOn(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const x of raw) {
      if (typeof x === 'string') out.push(x);
      else if (x && typeof x === 'object' && !Array.isArray(x)) {
        out.push(...Object.keys(x as object));
      }
    }
    return out;
  }
  if (typeof raw === 'object') {
    return Object.keys(raw as object);
  }
  return [];
}

function parseEnvMap(serviceDef: Record<string, unknown>): Record<string, string> {
  const env = serviceDef.environment;
  const out: Record<string, string> = {};
  if (env == null) return out;
  if (Array.isArray(env)) {
    for (const line of env) {
      if (typeof line !== 'string') continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
    return out;
  }
  if (typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}

function parseLabels(serviceDef: Record<string, unknown>): Record<string, string> {
  const raw = serviceDef.labels;
  if (raw == null) return {};
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const line of raw) {
      if (typeof line !== 'string') continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[String(k)] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}

function labelGet(labels: Record<string, string>, key: string): string | undefined {
  if (labels[key] != null && String(labels[key]).trim() !== '') return String(labels[key]).trim();
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(labels)) {
    if (k.toLowerCase() === lower && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

/**
 * Optional hints merged into each node's `config` for architecture lint after `archrad init --from` Compose.
 * Convention (service `labels:`):
 * - `archrad.auth` — e.g. `bearer` (satisfies IR-LINT-MISSING-AUTH-010 on HTTP entries)
 * - `archrad.auth_required: "false"` — explicit public entry (same rule opt-out)
 * - `archrad.health_url` or `archrad.health.url` — e.g. `/health` (helps IR-LINT-NO-HEALTHCHECK-003)
 * - `archrad.http.method` — optional, e.g. `GET`
 */
export function archradLintHintsFromLabels(labels: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const auth = labelGet(labels, 'archrad.auth');
  if (auth !== undefined) out.auth = auth;

  const pub = labelGet(labels, 'archrad.auth_required');
  if (pub !== undefined && pub.toLowerCase() === 'false') out.authRequired = false;

  const healthUrl = labelGet(labels, 'archrad.health_url') ?? labelGet(labels, 'archrad.health.url');
  if (healthUrl !== undefined) {
    out.url = healthUrl.startsWith('/') ? healthUrl : `/${healthUrl}`;
  }

  const method = labelGet(labels, 'archrad.http.method');
  if (method !== undefined) out.method = method;

  return out;
}

/** Extract hostname from common DB/cache/messaging URLs for cross-service edges. */
export function connectionUrlHost(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.startsWith('#')) return null;

  const tryHttp = (s: string): string | null => {
    try {
      const u = new URL(s);
      if (u.hostname) return u.hostname.toLowerCase();
    } catch {
      /* ignore */
    }
    return null;
  };

  const lower = t.toLowerCase();
  if (
    lower.startsWith('postgres://') ||
    lower.startsWith('postgresql://') ||
    lower.startsWith('mysql://') ||
    lower.startsWith('mariadb://') ||
    lower.startsWith('redis://') ||
    lower.startsWith('rediss://') ||
    lower.startsWith('amqp://') ||
    lower.startsWith('amqps://') ||
    lower.startsWith('mongodb://') ||
    lower.startsWith('mongodb+srv://')
  ) {
    const asHttp = t.replace(/^[^:]+:/, 'http:');
    return tryHttp(asHttp);
  }

  if (lower.startsWith('jdbc:')) {
    const rest = t.replace(/^jdbc:[^:]+:/i, '');
    const candidate = rest.startsWith('//') ? `http:${rest}` : `http://${rest}`;
    return tryHttp(candidate);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    return tryHttp(t);
  }

  return null;
}

const CONNECTION_ENV_KEYS = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'MYSQL_URL',
  'REDIS_URL',
  'AMQP_URL',
  'RABBITMQ_URL',
  'MONGODB_URI',
  'MONGO_URL',
  'ELASTICSEARCH_URL',
] as const;

function hasPublishedPorts(serviceDef: Record<string, unknown>): boolean {
  const ports = serviceDef.ports;
  if (ports == null) return false;
  if (Array.isArray(ports)) return ports.length > 0;
  if (typeof ports === 'object') return Object.keys(ports as object).length > 0;
  return typeof ports === 'string' && ports.length > 0;
}

function resolveImage(serviceName: string, serviceDef: Record<string, unknown>): string {
  const im = serviceDef.image;
  if (typeof im === 'string' && im.trim()) return im.trim();
  if (serviceDef.build != null) return `${serviceName}:build`;
  return `${serviceName}:latest`;
}

/**
 * Parse Docker Compose YAML and return canonical IR `{ graph: { metadata, nodes, edges } }`.
 */
export function dockerComposeToCanonicalIr(
  yamlText: string,
  options?: { fileLabel?: string },
): { ir: Record<string, unknown>; report: DockerComposeInitReport; verboseLines: string[] } {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new DockerComposeInitError(`Invalid YAML: ${msg}`);
  }

  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new DockerComposeInitError('Compose root must be a mapping (object).');
  }

  const root = doc as Record<string, unknown>;
  const servicesRaw = root.services;
  if (servicesRaw == null || typeof servicesRaw !== 'object' || Array.isArray(servicesRaw)) {
    throw new DockerComposeInitError('No services: mapping in Compose file.');
  }

  const services = servicesRaw as Record<string, unknown>;
  const names = Object.keys(services).filter((k) => !k.startsWith('x-'));
  if (names.length === 0) {
    throw new DockerComposeInitError('No services found in compose file.');
  }

  const idByServiceName = new Map<string, string>();
  for (const name of names) {
    idByServiceName.set(name, slugServiceId(name));
  }

  const warnings: string[] = [];
  const verboseLines: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  const edgeList: { from: string; to: string; reason: string }[] = [];
  /** One canonical edge per (from → to); duplicate IR edges trigger IR-LINT-DUPLICATE-EDGE-006. */
  const linkedPair = new Set<string>();

  const pushEdge = (from: string, to: string, reason: string) => {
    const pairKey = `${from}\0${to}`;
    if (linkedPair.has(pairKey)) return;
    linkedPair.add(pairKey);
    edgeList.push({ from, to, reason });
  };

  for (const serviceName of names) {
    const def = services[serviceName];
    if (def == null || typeof def !== 'object' || Array.isArray(def)) continue;
    const serviceDef = def as Record<string, unknown>;
    const id = idByServiceName.get(serviceName)!;
    const image = resolveImage(serviceName, serviceDef);
    const { type, warning } = inferTypeFromImage(image);
    if (warning) warnings.push(`${serviceName}: ${warning}`);

    let nodeType = type;
    if (type === 'service' && hasPublishedPorts(serviceDef)) {
      nodeType = 'gateway';
      verboseLines.push(`  ${id.padEnd(14)} gateway   (ports exposed — treating as HTTP-facing; image: ${image})`);
    } else {
      verboseLines.push(`  ${id.padEnd(14)} ${nodeType.padEnd(9)} (image: ${image})`);
    }

    const env = parseEnvMap(serviceDef);
    const networks = serviceDef.networks;
    const metaNetworks =
      networks == null
        ? []
        : Array.isArray(networks)
          ? networks.map((x) => String(x))
          : Object.keys(networks as object);

    const lintHints = archradLintHintsFromLabels(parseLabels(serviceDef));
    nodes.push({
      id,
      type: nodeType,
      name: serviceName,
      config: {
        ...lintHints,
        compose: {
          image,
          ...(Object.keys(env).length ? { envKeys: Object.keys(env).sort() } : {}),
          ...(metaNetworks.length ? { networks: metaNetworks } : {}),
        },
      },
    });

    // Connection URLs first so `DATABASE_URL`→DB wins when `depends_on` also lists the same DB
    // (Compose commonly sets both; they are one logical link in IR.)
    for (const key of CONNECTION_ENV_KEYS) {
      const val = env[key];
      if (!val) continue;
      const host = connectionUrlHost(val);
      if (!host || host === 'localhost' || host === '127.0.0.1') continue;

      let targetId: string | undefined;
      for (const [sn, sid] of idByServiceName) {
        if (host === sn.toLowerCase() || host === sid) {
          targetId = sid;
          break;
        }
      }
      if (!targetId) continue;
      pushEdge(id, targetId, `${key}`);
    }

    const deps = normalizeDependsOn(serviceDef.depends_on);
    for (const depName of deps) {
      const toId = idByServiceName.get(depName);
      if (!toId) {
        warnings.push(`depends_on: unknown service "${depName}" (from "${serviceName}")`);
        continue;
      }
      pushEdge(id, toId, 'depends_on');
    }
  }

  let ei = 0;
  const edges = edgeList.map((e) => {
    const id = `e_${e.from}_${e.to}_${ei++}`;
    const meta: Record<string, unknown> = { protocol: 'tcp', async: false };
    if (e.reason !== 'depends_on') {
      meta.relation = 'connectionUrl';
      meta.env = e.reason;
    } else {
      meta.relation = 'depends_on';
    }
    verboseLines.push(`  → ${e.from} → ${e.to}  edge  (${e.reason})`);
    return { id, from: e.from, to: e.to, metadata: meta };
  });

  const label = options?.fileLabel ?? 'docker-compose';
  const ir: Record<string, unknown> = {
    graph: {
      metadata: {
        name: label,
        description: 'Generated by archrad init from Docker Compose',
        provenance: { source: 'docker-compose', mode: 'init' },
      },
      nodes,
      edges,
    },
  };

  return {
    ir,
    report: { services: nodes.length, edges: edges.length, warnings },
    verboseLines,
  };
}
