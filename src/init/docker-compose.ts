/**
 * Docker Compose → canonical IR for `archrad init --from docker-compose.yml`.
 * Deterministic mapping: services → nodes, depends_on + connection URLs → edges.
 */

import yaml from 'js-yaml';
import { composeInterpolationBindings, expandComposeVars } from './compose-vars.js';
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

export type DockerComposeInitOptions = {
  fileLabel?: string;
  /** Caller bindings for Compose `${VAR}` / `:-` defaults (e.g. merged dotenv via `archrad init --compose-env-file`). */
  interpolateFrom?: Record<string, string>;
  /** When true, merge `process.env` before `interpolateFrom` so explicit keys win. */
  interpolateFromProcessEnv?: boolean;
};

function slugServiceId(name: string): string {
  const t = stripLeadingTrailingUnderscores(String(name).replace(/[^a-zA-Z0-9]+/g, '_')).toLowerCase();
  return (t || 'service').slice(0, 64);
}

/**
 * Docker image repository path sans digest/tag.
 * Parses only the `:tag` on the **final** path segment so `registry:5000/group/img:tag` keeps the registry host.
 */
export function normalizedComposeRepositoryPath(imageRef: string): string {
  const s = imageRef.trim().toLowerCase();
  if (!s) return '';
  const noDig = (s.split('@')[0] ?? '').trim();
  const lastSlash = noDig.lastIndexOf('/');
  const lastSeg = lastSlash >= 0 ? noDig.slice(lastSlash + 1) : noDig;
  const colon = lastSeg.lastIndexOf(':');
  if (colon > 0) {
    const tag = lastSeg.slice(colon + 1);
    if (/^[a-z0-9._+-]+$/.test(tag)) {
      if (lastSlash >= 0) {
        return `${noDig.slice(0, lastSlash + 1)}${lastSeg.slice(0, colon)}`;
      }
      return lastSeg.slice(0, colon);
    }
  }
  return noDig;
}

/**
 * Ports on these images are JDBC/TCP/Message ports — not HTTP API edges — so we must not
 * promote `service` → `gateway` (IR-LINT-MISSING-AUTH / MULTIPLE-HTTP / NO-HEALTHCHECK noise).
 */
function composeImageInferredAsNonHttpService(imageRef: string): boolean {
  const p = normalizedComposeRepositoryPath(imageRef);
  if (!p) return false;

  const dataStore =
    /\bpostgres\b|\bpostgresql\b|mysql|\bmariadb\b|percona|\bcockroachdb\b|\bcockroach\b|mongodb|mongo\b|oracle|edb\b|neo4j|clickhouse|couchdb|scylladb|cassandra|ravendb|timescaledb|\btimescale\b|snowflake\b|planetscale\b|milvus\b|weaviate\b|chromadb\b|etcd\b|\bzookeeper\b|\bmssql\b|azure-sql/;
  if (dataStore.test(p)) return true;

  const microsoftDb = /microsoft\.com\/(mssql|azure-sql|cbl-mariner)|mssql\/server/;
  if (microsoftDb.test(p)) return true;

  const cacheMq =
    /\bredis\b|\bredisstack\b|\bvalkey\b|memcached|\belasticache\b|rabbitmq|kafka|rocketmq|\bnats\b|pulsar|\bmqtt\b/;
  if (cacheMq.test(p)) return true;

  const searchStorage =
    /\belasticsearch\b|opensearch\b|meilisearch|typesense|\bsolr\b|\bminio\b|localstack/;
  if (searchStorage.test(p)) return true;

  const mailDevTools = /\bmaildev\b|mailhog|\bmailpit\b|axllent\/mailpit|mailslurper/;
  if (mailDevTools.test(p)) return true;

  if (/\bcoredns\b|kube-dns/.test(p)) return true;

  // Local emulators and HTTP test doubles. They speak HTTP and publish a port,
  // but they stand in for a cloud service during development — they are not an
  // entry point into the system under review, so linting them as one (missing
  // auth, extra HTTP entry) is pure noise. `localstack` is covered above.
  const emulators =
    /\bfauxqs\b|\bwiremock\b|mockserver|\bmountebank\b|\bhoverfly\b|\bmoto\b|\bgcs-emulator\b|firebase-tools|\bfake-gcs-server\b|azurite|dynamodb-local|\bsmocker\b|\bprism\b/;
  if (emulators.test(p)) return true;

  return false;
}

/** Infer node.type from Docker image reference (before tag/digest). */
export function inferTypeFromImage(imageRef: string): { type: string; warning?: string } {
  const trimmed = String(imageRef).trim();
  const hay = normalizedComposeRepositoryPath(trimmed);

  /** Last slash segment (helps short refs like postgres:15). */
  const last = hay.includes('/') ? hay.split('/').pop() ?? hay : hay;

  // IdPs / SSO containers expose HTTP but are identity infrastructure, not "API missing auth".
  const idp =
    /keycloak\b|dexidp\/dex|authentik\/|quay\.io\/keycloak|bitnami\/keycloak|^oryd\/hydra/.test(hay);
  if (idp) {
    return { type: 'keycloak' };
  }

  if (/\bcoredns\b|coredns\/|kube-dns/.test(hay) || /\bcoredns\b|kube-dns/.test(last)) {
    return { type: 'dns' };
  }

  /**
   * Datastores the IR models as their own node type. These MUST be matched before
   * the generic bucket below: the code extractor already emits `mongodb`/`mysql`/
   * `cassandra`/`sqlserver` (see `dbNodeType`), so bucketing the compose tier's
   * MongoDB container as `postgres` both mislabels it ("datastore node
   * postgres_mongodb") and blocks cross-tier unification, since scan groups
   * singleton infra by exact type.
   */
  const SPECIFIC_DATASTORES: { type: string; hay: RegExp; last: RegExp }[] = [
    { type: 'mongodb', hay: /\bmongodb\b|\bmongo\b/, last: /^mongodb?\b|^mongo/ },
    { type: 'mysql', hay: /\bmysql\b|\bmariadb\b|percona/, last: /^mysql|^mariadb|^percona/ },
    { type: 'cassandra', hay: /\bcassandra\b|scylladb/, last: /^cassandra|^scylla/ },
    {
      type: 'sqlserver',
      hay: /microsoft\.com\/(mssql|azure-sql)|mssql\/server|microsoft\/azure-sql|azure-sql-edge|\bmssql\b/,
      last: /^mssql|^azure-sql/,
    },
  ];
  for (const candidate of SPECIFIC_DATASTORES) {
    if (candidate.hay.test(hay) || candidate.last.test(last)) {
      return { type: candidate.type };
    }
  }

  /**
   * Remaining datastores — IR uses a heterogeneous `postgres` bucket historically
   * (still DB-like via isDbLikeType).
   */
  const dataHay =
    /\bpostgres\b|\bpostgresql\b|mysql|\bmariadb\b|percona|cockroachdb|\bcockroach\/|mongodb|mongo\b|\boracle\b|edb\/postgres|edb\/postgresql|microsoft\.com\/(mssql|azure-sql|cbl-mariner)|mssql\/server|microsoft\/azure-sql|azure-sql-edge|timescaledb|\btimescale\b|snowflake\b|planetscale\b|milvus\b|neo4j|clickhouse|couchdb|ravendb|scylladb|cassandra\b|singlestore\b|\bhana\b|hive\b|hdfs\b/;
  const dataLast =
    /postgres|postgresql|mysql|mariadb|percona|cockroachdb|cockroach|mssql|mongo|mongodb|oracle|timescale|couch|cassandra/;
  if (dataHay.test(hay) || dataLast.test(last)) {
    return { type: 'postgres' };
  }

  if (/\bredis\b|\bredisstack\b|\bvalkey\b|memcached|\belasticache\b|\bdragonfly\b/.test(hay) || /\bredis\b|memcached/.test(last)) {
    return { type: 'cache' };
  }
  if (
    /\brabbitmq\b|\bkafka\b|cp-kafka|confluentinc\/|msk\.amazonaws|kafka\.amazonaws|amazonmq|natsio\/|\/pulsar|apachepulsar|rocketmq|^nsqd|mqtt|^eclipse-mosquitto|beanstalk/i.test(hay) ||
    /rabbitmq|kafka|^nats|^pulsar|^cp-kafka|rocketmq|^nsqd|^mosquitto|^beanstalkd/.test(last)
  ) {
    return { type: 'queue' };
  }
  const gw =
    /\bnginx\b|\bopenresty\b|\btraefik\b|\bcaddy\b|\bhaproxy\b|\bkong\b|\benvoy\b|\bistio\b|^ambassador|^gloo-/i;
  if (gw.test(hay) || /\bnginx|traefik|caddy|haproxy|\bkong|envoy/.test(last)) {
    return { type: 'gateway' };
  }
  if (
    /\belasticsearch\b|opensearch\b|^meilisearch|typesense|\bsolr\b/.test(hay) ||
    /\belastic|opensearch|solr|^meilisearch|typesense/.test(last)
  ) {
    return { type: 'search' };
  }
  if (/\bminio\b|\blocalstack\b/.test(last) || /\bminio\b|\blocalstack\b/.test(hay)) {
    return { type: 'storage' };
  }
  if (/mailhog|maildev|mailpit|mailslurper|axllent\/mailpit/.test(hay) || /mailhog|maildev|mailpit|mailslurper/.test(last)) {
    return { type: 'smtp' };
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

/**
 * Compose interpolates `${VAR:-default}` at deploy time; static YAML parsers keep the literal.
 * Extract **`default`** so `depends_on: - ${_APP_DB_HOST:-mongodb}` maps to service key `mongodb`.
 */
export function composeDependsOnDefaultServiceKey(depEntry: string): string | null {
  const d = depEntry.trim();
  const m = d.match(/^\$\{[^:]+:\-([^}]+)\}$/);
  return m !== null ? String(m[1]).trim() : null;
}

/** Resolve Compose `depends_on` entry to an existing **`services:`** key (handles `${:-defaults}` + expanded vars). */
function composeDependsOnResolvedServiceKey(
  declaredRaw: string,
  serviceKeys: Iterable<string>,
  vars: Record<string, string>,
): string {
  const expanded = expandComposeVars(declaredRaw.trim(), vars);
  let key = composeDependsOnDefaultServiceKey(expanded);
  key = key !== null ? key : expanded.trim();

  const keySet = new Set(serviceKeys);
  if (keySet.has(key)) return key;

  const lk = key.toLowerCase();
  for (const sk of serviceKeys) {
    if (sk.toLowerCase() === lk) return sk;
  }
  return key;
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

function parseExpandedEnvMap(
  serviceDef: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, string> {
  const raw = parseEnvMap(serviceDef);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = expandComposeVars(v, vars);
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

/** Expand **`${VAR}`** in Compose **`labels:`** values (Traefik/backend names often templated). */
function parseLabelsExpanded(
  serviceDef: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, string> {
  const raw = parseLabels(serviceDef);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = expandComposeVars(v, vars);
  }
  return out;
}

/**
 * Collect Traefik **`traefik.http.services.*.loadbalancer.*`** backend names plus router **`.service`** targets.
 */
export function enumerateTraefikHttpBackendRefs(labels: Record<string, string>): Set<string> {
  const refs = new Set<string>();
  for (const [key0, val0] of Object.entries(labels)) {
    const key = key0.trim();
    const mSvc = /^traefik\.http\.services\.([^.\s]+)\.loadbalancer/i.exec(key);
    if (mSvc?.[1]) refs.add(String(mSvc[1]).trim());

    const lk = key.toLowerCase();
    if (lk.startsWith('traefik.http.routers.') && /\.service$/i.test(key)) {
      const v = String(val0).trim();
      if (v !== '') refs.add(v);
    }
  }
  return refs;
}

function composeServiceNameForTraefikRef(ref: string, names: readonly string[]): string | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  const rl = r.toLowerCase();
  const slugRef = slugServiceId(r.replace(/-/g, '_'));

  for (const sn of names) {
    if (sn.toLowerCase() === rl) return sn;
    if (slugServiceId(sn) === slugRef) return sn;
    const snSlug = slugServiceId(sn).toLowerCase();
    if (snSlug === rl.replace(/-/g, '_')) return sn;
  }
  return undefined;
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

export const CONNECTION_ENV_KEYS = [
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

/** Hostname-only deps (Compose rarely uses full JDBC/Redis URLs — match service DNS name). */
export const HOST_ONLY_ENV_KEYS = [
  'DATABASE_HOST',
  'DB_HOST',
  'POSTGRES_HOST',
  'PGHOST',
  'PGHOSTADDR',
  'MYSQL_HOST',
  'MARIADB_HOST',
  'REDIS_HOST',
  'MONGODB_HOST',
  'MONGO_HOST',
  'RABBITMQ_HOST',
  'MEMCACHED_HOST',
  'ELASTICSEARCH_HOST',
  '_APP_DB_HOST',
  '_APP_REDIS_HOST',
  '_APP_DB_HOST_VECTORSDB',
] as const;

/**
 * Parses plain **hostname** (`db`, `redis`, `postgresql:5432`) from env values for Compose edge inference.
 * Returns **`null`** for URLs (`postgres://`), paths, templating shells, localhost.
 */
export function composePlainEnvHostname(val: string): string | null {
  const raw = val.trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;
  if (/[\s$`]|^#|%\{|%\(/.test(raw)) return null;
  // A bare `host:port` is checked BEFORE the URL-scheme guard below, because a
  // service is routinely named after the engine it runs: `redis:6379` and
  // `mysql:3306` are host/port pairs, not `redis://` URLs, and the scheme guard
  // alone would discard exactly the values a DNS-named cluster produces.
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*:\d{1,5}$/.test(raw)) {
    const host = raw.slice(0, raw.lastIndexOf(':')).toLowerCase();
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(host) ? null : host;
  }
  if (/^(https?:|jdbc:|postgres(?:ql)?:|mysql:|mongodb(?:\+srv)?:|redis:|amqp|amqps:)/i.test(raw)) return null;
  if (raw.includes('/') || raw.includes('\\')) return null;

  let hostPart = raw;
  const portSep = /^(.+):(\d{1,5})$/.exec(raw);
  if (portSep?.[1] && portSep[2]) {
    if (!/^[a-zA-Z0-9._-]+$/.test(portSep[1])) return null;
    hostPart = portSep[1];
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostPart)) return null;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(hostPart)) return null;
  return hostPart.toLowerCase();
}

/** Longest paths first (`/health` is a prefix of `/healthcheck`; `/healthy` avoids `/health` false positive). */
const COMPOSE_HEALTH_PROBE_PATH_ORDER = [
  '/healthcheck',
  '/healthz',
  '/healthy',
  '/health',
  '/ready',
  '/alive',
  '/live',
  '/status',
  '/ping',
] as const;

/**
 * When Compose **`healthcheck.test`** invokes curl/wget (or URLs) against a readiness path,
 * derive **`config.url`** / **`method`** hints so IR-LINT-NO-HEALTHCHECK-003 can clear without OpenAPI ingestion.
 *
 * Compose **`labels`** (`archrad.health_url`) still win when merged afterward.
 */
export function composeHealthcheckToLintHints(healthRaw: unknown): Record<string, unknown> {
  if (healthRaw == null || typeof healthRaw !== 'object' || Array.isArray(healthRaw)) return {};
  const rec = healthRaw as Record<string, unknown>;
  const test = rec.test;
  let blob = '';
  if (typeof test === 'string') blob = test;
  else if (Array.isArray(test))
    blob = test.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  else return {};

  const lower = blob.toLowerCase().replace(/\r\n/g, '\n');

  /** CMD-SHELL and curl/wget frequently appear concatenated without spaces in joined argv blobs. */
  const probeLike =
    /https?:\/\//i.test(blob) ||
    /\bcurl\b/i.test(blob) ||
    /\bwget\b/i.test(blob) ||
    /\bcmd-shell\b/i.test(lower);

  if (!probeLike) return {};

  for (const prefix of COMPOSE_HEALTH_PROBE_PATH_ORDER) {
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(prefix, from);
      if (idx === -1) break;
      const beforeChar = idx > 0 ? lower[idx - 1]! : ' ';
      const afterIdx = idx + prefix.length;
      const afterChar = afterIdx < lower.length ? lower[afterIdx]! : ' ';
      /**
       * Path segment after hostname: `http://h:8080/health`, ` (...) /healthy`, whitespace, etc.
       * Rejects `postgresql/health` (letter before slash) without blocking port digits (`8080/health`).
       */
      const boundaryBefore =
        idx === 0 ||
        /\s|'|"|`|\(|\|/.test(beforeChar) ||
        /[/:]/.test(beforeChar) ||
        /\d/.test(beforeChar);
      const boundaryAfter = !/[a-z0-9_]/.test(afterChar);
      /** Reject `/health` when it is really the prefix of `/healthy`. */
      const notHealthyPrefixHack = !(prefix === '/health' && afterChar === 'y');

      if (boundaryBefore && boundaryAfter && notHealthyPrefixHack) return { url: prefix, method: 'GET' };

      from = idx + 1;
    }
  }

  return {};
}

function hasPublishedPorts(serviceDef: Record<string, unknown>): boolean {
  const ports = serviceDef.ports;
  if (ports == null) return false;
  if (Array.isArray(ports)) return ports.length > 0;
  if (typeof ports === 'object') return Object.keys(ports as object).length > 0;
  return typeof ports === 'string' && ports.length > 0;
}

/**
 * The build context of a service, normalized, or null when it is not built from
 * a local path (no `build:`, or a remote git context like
 * `build: https://github.com/…`).
 *
 * `'.'` means "the directory holding this compose file". Callers use that to tell
 * a service built from the whole repo apart from one built out of a subdirectory
 * (`build: ./tests/`), which is a sibling component, not the repo's app.
 */
export function composeLocalBuildContext(serviceDef: Record<string, unknown>): string | null {
  const build = serviceDef.build;
  if (build == null) return null;
  const context =
    typeof build === 'string'
      ? build
      : typeof build === 'object' && !Array.isArray(build)
        ? (build as Record<string, unknown>).context
        : undefined;
  // `build: {}` with no context defaults to the compose file's own directory.
  if (context == null) return '.';
  if (typeof context !== 'string') return null;
  const trimmed = context.trim();
  if (!trimmed) return '.';
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github\.com\/)/i.test(trimmed)) return null;
  // Normalize './', './/', 'a/b/' → '.', 'a/b'
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === '' || normalized === '.' ? '.' : normalized.replace(/^\.\//, '');
}

function resolveImage(serviceName: string, serviceDef: Record<string, unknown>): string {
  const im = serviceDef.image;
  if (typeof im === 'string' && im.trim()) return im.trim();
  if (serviceDef.build != null) return `${serviceName}:build`;
  return `${serviceName}:latest`;
}

const JSON_SCHEMA = yaml.JSON_SCHEMA;

/**
 * Load Compose YAML: supports multi-document files (leading `---` / empty first doc)
 * where `yaml.load` would return null. Picks the first mapping with a `services` object.
 */
function parseComposeYamlRoot(yamlText: string): Record<string, unknown> {
  const docs: unknown[] = [];
  try {
    yaml.loadAll(yamlText, (d) => docs.push(d), { schema: JSON_SCHEMA });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new DockerComposeInitError(`Invalid YAML: ${msg}`);
  }

  const isPlainObject = (x: unknown): x is Record<string, unknown> =>
    x != null && typeof x === 'object' && !Array.isArray(x);

  for (const doc of docs) {
    if (!isPlainObject(doc)) continue;
    const s = doc.services;
    if (s != null && typeof s === 'object' && !Array.isArray(s)) {
      return doc;
    }
  }
  for (const doc of docs) {
    if (isPlainObject(doc)) return doc;
  }

  if (docs.length === 0 || docs.every((d) => d == null)) {
    throw new DockerComposeInitError(
      'Compose root must be a mapping (object). The file parsed to no content (empty file, comments only, or not YAML).',
    );
  }
  const kinds = docs.map((d) =>
    d == null ? 'null' : Array.isArray(d) ? 'array' : typeof d,
  );
  throw new DockerComposeInitError(
    `Compose root must be a mapping (object). Parsed document(s): ${kinds.join(', ')}. Expected a top-level YAML object with a "services:" key.`,
  );
}

/**
 * Parse Docker Compose YAML and return canonical IR `{ graph: { metadata, nodes, edges } }`.
 */
export function dockerComposeToCanonicalIr(
  yamlText: string,
  options?: DockerComposeInitOptions,
): { ir: Record<string, unknown>; report: DockerComposeInitReport; verboseLines: string[] } {
  const iv = composeInterpolationBindings(
    options?.interpolateFrom,
    Boolean(options?.interpolateFromProcessEnv),
  );
  const root = parseComposeYamlRoot(yamlText);
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
      if (composeImageInferredAsNonHttpService(image)) {
        verboseLines.push(
          `  ${id.padEnd(14)} ${nodeType.padEnd(9)} (ports exposed — not HTTP API edge; inferred TCP/matrix service; image: ${image})`,
        );
      } else {
        nodeType = 'gateway';
        verboseLines.push(`  ${id.padEnd(14)} gateway   (ports exposed — treating as HTTP-facing; image: ${image})`);
      }
    } else {
      verboseLines.push(`  ${id.padEnd(14)} ${nodeType.padEnd(9)} (image: ${image})`);
    }

    const env = parseExpandedEnvMap(serviceDef, iv);
    const networks = serviceDef.networks;
    const metaNetworks =
      networks == null
        ? []
        : Array.isArray(networks)
          ? networks.map((x) => String(x))
          : Object.keys(networks as object);

    const lintFromHealth = composeHealthcheckToLintHints(serviceDef.healthcheck);
    const lintFromLabels = archradLintHintsFromLabels(parseLabelsExpanded(serviceDef, iv));
    const lintHints = { ...lintFromHealth, ...lintFromLabels };
    nodes.push({
      id,
      type: nodeType,
      name: serviceName,
      config: {
        ...lintHints,
        compose: {
          image,
          // Local build context (`.` = this compose file's own directory) rather
          // than a pulled image — factual metadata `scan` uses to recognise which
          // service is the app under scan.
          ...(() => {
            const ctx = composeLocalBuildContext(serviceDef);
            return ctx == null ? {} : { buildContext: ctx };
          })(),
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

    for (const key of HOST_ONLY_ENV_KEYS) {
      const val = env[key];
      if (!val) continue;
      const hostPlain = composePlainEnvHostname(val);
      if (!hostPlain) continue;
      let targetId: string | undefined;
      for (const [sn, sid] of idByServiceName) {
        if (hostPlain === sn.toLowerCase() || hostPlain === sid.toLowerCase()) {
          targetId = sid;
          break;
        }
      }
      if (!targetId) continue;
      pushEdge(id, targetId, `${key}`);
    }

    const deps = normalizeDependsOn(serviceDef.depends_on);
    for (const rawDep of deps) {
      const depKey = composeDependsOnResolvedServiceKey(rawDep, names, iv);
      const toId = idByServiceName.get(depKey);
      if (!toId) {
        warnings.push(`depends_on: unknown service "${depKey}" (from "${serviceName}")`);
        continue;
      }
      pushEdge(id, toId, 'depends_on');
    }
  }

  /** Traefik HTTP routers / services labels → inferred gateway/backend edges. */
  for (const fromName of names) {
    const def = services[fromName];
    if (def == null || typeof def !== 'object' || Array.isArray(def)) continue;
    const serviceDef = def as Record<string, unknown>;
    const labels = parseLabelsExpanded(serviceDef, iv);
    const refs = enumerateTraefikHttpBackendRefs(labels);
    if (refs.size === 0) continue;
    const fromId = idByServiceName.get(fromName)!;
    for (const ref of refs) {
      const toName = composeServiceNameForTraefikRef(ref, names);
      if (!toName) {
        warnings.push(`traefik labels: unknown backend service "${ref}" (referenced from "${fromName}")`);
        continue;
      }
      const toId = idByServiceName.get(toName)!;
      if (fromId === toId) continue;
      pushEdge(fromId, toId, `traefik:${ref}`);
    }
  }

  let ei = 0;
  const edges = edgeList.map((e) => {
    const id = `e_${e.from}_${e.to}_${ei++}`;
    const meta: Record<string, unknown> = { protocol: 'tcp', async: false };
    if (e.reason === 'depends_on') {
      meta.relation = 'depends_on';
    } else if (e.reason.startsWith('traefik:')) {
      meta.relation = 'traefikIngress';
      meta.traefikBackend = e.reason.slice('traefik:'.length);
    } else {
      meta.relation = 'connectionUrl';
      meta.env = e.reason;
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
