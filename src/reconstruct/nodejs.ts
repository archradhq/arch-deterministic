/**
 * Node.js / TypeScript source-code pattern analyzer.
 * Detects HTTP routes, DB connections, auth middleware, external calls,
 * workers, and service entry points using regex scanning.
 */

import type { DetectedArtifact } from './types.js';
import type { ScannedFile } from './file-walker.js';
import { lineAt, lineFromMatch, matchAll, testHit } from './scan-utils.js';

// ---- helpers ----------------------------------------------------------------

function pushRouteArtifact(
  artifacts: DetectedArtifact[],
  file: ScannedFile,
  match: RegExpMatchArray,
  kind: DetectedArtifact['kind'],
  detail: string,
): void {
  artifacts.push({
    kind,
    detail,
    file: file.relPath,
    line: lineFromMatch(file.content, match),
  });
}

/** Extract just the hostname from a full URL string. */
function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Fallback: strip protocol and path
    return url.replace(/^https?:\/\//, '').split(/[/:?#]/)[0] ?? url;
  }
}

/** Convert a hostname like "api.stripe.com" to a short service label "stripe". */
function labelFromHostname(hostname: string): string {
  // Strip www. / api. / auth. prefixes
  const stripped = hostname.replace(/^(?:www|api|auth|cdn|static|assets|s3|storage)\./i, '');
  // Take first two parts: "stripe.com" → "stripe", "auth0.com" → "auth0"
  const parts = stripped.split('.');
  return (parts[0] ?? stripped).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

// ---- HTTP route patterns ----------------------------------------------------

const HEALTH_PATH_RE = /^(\/health(?:z|check)?|\/healthy|\/ready|\/live|\/ping|\/status|\/alive)\b/i;

/** Express / Koa / Hono: app.get('/path', ...) or router.post('/path', ...) */
const EXPRESS_ROUTE_RE =
  /(?:app|router|server|route)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;

/**
 * Fastify's full route declaration on ANY receiver: `app.route({ url, method })`,
 * `server.route({...})`, `instance.route({...})`. {@link FASTIFY_ROUTE_RE} only
 * recognises the object form when the variable happens to be named `fastify` or
 * `server`, but Fastify's own docs and most codebases call it `app` — which meant
 * canonical Fastify health probes (`app.route({ url: '/live' })`) were invisible
 * and every Fastify service false-fired IR-LINT-NO-HEALTHCHECK-003.
 *
 * Captures the object head (up to the first nested `}` or the closing brace), from
 * which `url` and `method` are read. Nested option objects such as
 * `schema: { hide: true }` terminate the capture, which is fine: `url`/`method` are
 * conventionally declared first.
 */
const FASTIFY_ROUTE_OBJECT_RE =
  /\b[A-Za-z_$][\w$]*\s*\.\s*route\s*\(\s*\{([^}]*)/gi;
const FASTIFY_ROUTE_URL_RE = /\burl\s*:\s*['"`]([^'"`\n]+)['"`]/i;
const FASTIFY_ROUTE_METHOD_RE = /\bmethod\s*:\s*(?:\[\s*)?['"`]([A-Za-z]+)['"`]/i;

/** Fastify: fastify.get('/path', ...) */
const FASTIFY_ROUTE_RE =
  /(?:fastify|server)\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`\n]+)['"`]|(?:fastify|server)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;

/** NestJS @Controller + @Get/@Post etc. */
const NEST_CONTROLLER_RE = /@Controller\s*\(\s*['"`]?([^'"`)\n]*?)['"`]?\s*\)/gi;
const NEST_VERB_RE = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\s*\(\s*['"`]?([^'"`)\n]*?)['"`]?\s*\)/gi;

// ---- App entry detection ----------------------------------------------------

/** File calls app.listen() / server.listen() / fastify.listen() — marks HTTP server entry point. */
const APP_LISTEN_RE =
  /(?:app|server|fastify|koa|httpServer)\s*\.\s*(?:listen|start)\s*\(/i;

// ---- Worker / queue patterns ------------------------------------------------

const BULLMQ_WORKER_RE = /new\s+Worker\s*\(\s*['"`]([^'"`]+)['"`]/gi;
const AGENDA_DEF_RE = /agenda\.define\s*\(\s*['"`]([^'"`]+)['"`]/gi;
const NODE_CRON_RE = /(?:cron\.schedule|schedule\.scheduleJob)\s*\(/i;

// ---- DB connection patterns -------------------------------------------------

type DbPattern = { re: RegExp; dbType: string; detail: string };

const DB_PATTERNS: DbPattern[] = [
  { re: /(?:require|from)\s*\(?\s*['"`]pg['"`]/, dbType: 'postgres', detail: 'pg (PostgreSQL)' },
  { re: /new\s+Pool\s*\(|new\s+Client\s*\(\s*\{/, dbType: 'postgres', detail: 'pg Pool/Client' },
  { re: /(?:require|from)\s*\(?\s*['"`]@prisma\/client['"`]|PrismaClient/, dbType: 'postgres', detail: 'Prisma ORM' },
  {
    re: /(?:require|from)\s*\(?\s*['"`]typeorm['"`]|createConnection\s*\(\s*\{|DataSource\s*\(\s*\{/,
    dbType: 'postgres',
    detail: 'TypeORM',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]sequelize['"`]|new\s+Sequelize\s*\(/,
    dbType: 'postgres',
    detail: 'Sequelize ORM',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]mysql2?['"`]/,
    dbType: 'mysql',
    detail: 'mysql/mysql2 driver',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]mariadb['"`]/,
    dbType: 'mysql',
    detail: 'mariadb driver',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]mongoose['"`]|mongoose\.connect\s*\(/,
    dbType: 'mongodb',
    detail: 'Mongoose (MongoDB)',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]mongodb['"`]|MongoClient/,
    dbType: 'mongodb',
    detail: 'MongoDB native driver',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`](?:redis|ioredis)['"`]|createClient\s*\(\s*\{/,
    dbType: 'cache',
    detail: 'Redis client',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]bullmq['"`]/,
    dbType: 'cache',
    detail: 'BullMQ (Redis backend)',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]@elastic\/elasticsearch['"`]|new\s+ElasticsearchClient\s*\(/,
    dbType: 'search',
    detail: 'Elasticsearch client',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]cassandra-driver['"`]/,
    dbType: 'cassandra',
    detail: 'Cassandra driver',
  },
  {
    re: /(?:require|from)\s*\(?\s*['"`]firebase-admin['"`]|admin\.firestore\s*\(\)|admin\.database\s*\(\)/,
    dbType: 'firestore',
    detail: 'Firebase Admin',
  },
];

/**
 * Env var patterns with a capturing group (group 1) for the actual variable name.
 * Detection order matters: more specific patterns first.
 */
type DbEnvPattern = { re: RegExp; dbType: string };

const DB_ENV_PATTERNS: DbEnvPattern[] = [
  {
    re: /\bprocess\.env\.(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|PGHOST|POSTGRES_HOST|PGDATABASE|POSTGRES_URI|PG_URI|PG_CONNECTION_STRING)\b/,
    dbType: 'postgres',
  },
  {
    re: /\bprocess\.env\.(MYSQL_URL|MYSQL_HOST|MYSQL_DATABASE|MYSQL_URI)\b/,
    dbType: 'mysql',
  },
  {
    re: /\bprocess\.env\.(MONGO(?:DB)?_(?:URI|URL|HOST)|MONGODB_CONNECTION_STRING)\b/,
    dbType: 'mongodb',
  },
  {
    // Capture any env var with REDIS in the name
    re: /\bprocess\.env\.([A-Z][A-Z0-9_]*REDIS[A-Z0-9_]*|REDIS_(?:URL|HOST|URI|PORT|CONNECTION_STRING))\b/,
    dbType: 'cache',
  },
  {
    re: /\bprocess\.env\.(ELASTICSEARCH_URL|ELASTIC_URL|OPENSEARCH_URL)\b/,
    dbType: 'search',
  },
];

/**
 * Capture the variable name used to hold a DB connection.
 * e.g. `const userDb = new Pool(...)` → captures "userDb"
 */
const DB_CONN_VAR_RE =
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:new\s+)?(?:Pool|Client|Sequelize|PrismaClient|MongoClient)\s*\(/gi;

// ---- Auth patterns ----------------------------------------------------------

type AuthPattern = { re: RegExp; detail: string };

const AUTH_PATTERNS: AuthPattern[] = [
  // Require actual usage, not a bare `import passport` — importing the library
  // does not mean this file wires up auth middleware (avoids false-positive
  // auth nodes from import statements).
  { re: /passport\.(?:authenticate|initialize|session|use)\s*\(/, detail: 'Passport.js' },
  { re: /(?:require|from)\s*\(?\s*['"`]express-jwt['"`]|expressJwt\s*\(/, detail: 'express-jwt middleware' },
  // Fastify's auth plugins were renamed to the `@fastify/` scope in v3; match both
  // the legacy and current names, plus the `jwtVerify()` decorator the plugin adds
  // (which is how request-level auth is actually enforced in Fastify apps).
  {
    re: /(?:require|from)\s*\(?\s*['"`](?:fastify-jwt|@fastify\/(?:jwt|auth|passport|basic-auth|bearer-auth))['"`]|\.register\s*\(\s*fastifyJwt|\.jwtVerify\s*\(/,
    detail: 'Fastify JWT/auth plugin',
  },
  { re: /(?:require|from)\s*\(?\s*['"`]jsonwebtoken['"`]|jwt\.verify\s*\(/, detail: 'jsonwebtoken' },
  { re: /@UseGuards\s*\(/, detail: 'NestJS @UseGuards' },
  { re: /@AuthGuard\s*\(/, detail: 'NestJS @AuthGuard' },
  {
    re: /(?:require|from)\s*\(?\s*['"`]auth0['"`]|new\s+(?:AuthenticationClient|ManagementClient)\s*\(/,
    detail: 'Auth0 SDK',
  },
  { re: /(?:require|from)\s*\(?\s*['"`]@okta\//, detail: 'Okta SDK' },
  {
    re: /(?:require|from)\s*\(?\s*['"`]keycloak-connect['"`]|new\s+Keycloak\s*\(/,
    detail: 'Keycloak Connect',
  },
  { re: /(?:require|from)\s*\(?\s*['"`]amazon-cognito/, detail: 'AWS Cognito SDK' },
  { re: /(?:require|from)\s*\(?\s*['"`]@aws-amplify\/auth['"`]/, detail: 'AWS Amplify Auth' },
  { re: /\.use\s*\(\s*requiresAuth\s*\(/, detail: 'auth middleware registration' },
];

// ---- Service-to-service call patterns --------------------------------------

type SvcCallPattern = { re: RegExp; detail: string };

const SERVICE_CALL_PATTERNS: SvcCallPattern[] = [
  { re: /(?:require|from)\s*\(?\s*['"`]axios['"`]/, detail: 'axios HTTP client' },
  { re: /axios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/, detail: 'axios HTTP call' },
  { re: /(?:require|from)\s*\(?\s*['"`]got['"`]/, detail: 'got HTTP client' },
  { re: /(?:require|from)\s*\(?\s*['"`]node-fetch['"`]/, detail: 'node-fetch' },
  { re: /(?:require|from)\s*\(?\s*['"`]@grpc\/grpc-js['"`]/, detail: 'gRPC client' },
  {
    re: /new\s+\w+ServiceClient\s*\(\s*process\.env\./,
    detail: 'gRPC client from env',
  },
  {
    re: /HttpClient|HttpService|fetch\s*\(\s*(?:process\.env|`https?:\/\/|['"]https?:\/\/)/,
    detail: 'HTTP service client',
  },
];

// ---- External HTTP destination extraction ----------------------------------

/**
 * Captures hardcoded URLs passed to HTTP client calls.
 * Group 1 = full URL.
 */
const EXTERNAL_URL_CALL_RE =
  /(?:axios|fetch|got|superagent|needle|undici|request)\s*(?:\.\s*(?:get|post|put|patch|delete|head|request)\s*)?\(\s*['"`](https?:\/\/[^'"`\s,)]+)['"`]/gi;

/**
 * gRPC client target strings.
 * e.g. new PaymentServiceClient('payments-svc:50051') → "payments-svc"
 */
const GRPC_TARGET_RE =
  /new\s+(\w+)ServiceClient\s*\(\s*['"`]([^'"`\s,)]+)['"`]/gi;

// ---- analysis entry point ---------------------------------------------------

export function analyzeNodejsFile(file: ScannedFile): DetectedArtifact[] {
  const artifacts: DetectedArtifact[] = [];
  const { relPath, content } = file;

  // Express / Koa routes
  for (const m of matchAll(file.content, EXPRESS_ROUTE_RE.source)) {
    const method = (m[1] ?? 'GET').toUpperCase();
    const path = m[2] ?? '/';
    const kind = HEALTH_PATH_RE.test(path) ? 'health_route' : 'http_route';
    pushRouteArtifact(artifacts, file, m, kind, `${method} ${path}`);
  }

  // Fastify routes
  for (const m of matchAll(file.content, FASTIFY_ROUTE_RE.source)) {
    const method = (m[3] ?? m[1] ?? 'GET').toUpperCase();
    const path = m[4] ?? m[2] ?? '/';
    const kind = HEALTH_PATH_RE.test(path) ? 'health_route' : 'http_route';
    pushRouteArtifact(
      artifacts,
      file,
      m,
      kind,
      `fastify.${method.toLowerCase()}(${path})`,
    );
  }

  // Fastify full route declarations: <anything>.route({ url, method })
  for (const m of matchAll(file.content, FASTIFY_ROUTE_OBJECT_RE.source)) {
    const body = m[1] ?? '';
    const path = body.match(FASTIFY_ROUTE_URL_RE)?.[1];
    if (!path) continue;
    const method = (body.match(FASTIFY_ROUTE_METHOD_RE)?.[1] ?? 'GET').toUpperCase();
    const kind = HEALTH_PATH_RE.test(path) ? 'health_route' : 'http_route';
    pushRouteArtifact(artifacts, file, m, kind, `route({ ${method} ${path} })`);
  }

  // NestJS @Controller + @Verb
  const nestVerbs = matchAll(file.content, NEST_VERB_RE.source);
  const nestCtrl = matchAll(file.content, NEST_CONTROLLER_RE.source);
  if (nestCtrl.length > 0 || nestVerbs.length > 0) {
    if (nestVerbs.length > 0) {
      for (const m of nestVerbs) {
        const path = m[2] ?? '/';
        const kind = HEALTH_PATH_RE.test(path) ? 'health_route' : 'http_route';
        pushRouteArtifact(artifacts, file, m, kind, `@${m[1] ?? 'Get'}("${path}")`);
      }
    } else {
      const m = nestCtrl[0];
      if (m) {
        artifacts.push({
          kind: 'http_route',
          detail: 'NestJS @Controller',
          file: relPath,
          line: lineFromMatch(content, m),
        });
      }
    }
  }

  // App entry point (file starts the HTTP server)
  const listenHit = testHit(APP_LISTEN_RE, content);
  if (listenHit.hit) {
    artifacts.push({
      kind: 'app_entry',
      detail: 'app.listen()',
      file: relPath,
      line: listenHit.line,
    });
  }

  // Worker definitions (BullMQ, Agenda, node-cron)
  let workerEmitted = false;
  for (const m of matchAll(content, BULLMQ_WORKER_RE.source)) {
    if (workerEmitted) break;
    const queueName = m[1] ?? 'jobs';
    artifacts.push({
      kind: 'worker_definition',
      detail: `BullMQ Worker("${queueName}")`,
      file: relPath,
      line: lineFromMatch(content, m),
    });
    workerEmitted = true;
  }
  if (!workerEmitted) {
    for (const m of matchAll(content, AGENDA_DEF_RE.source)) {
      const jobName = m[1] ?? 'job';
      artifacts.push({
        kind: 'worker_definition',
        detail: `Agenda.define("${jobName}")`,
        file: relPath,
        line: lineFromMatch(content, m),
      });
      workerEmitted = true;
      break;
    }
  }
  if (!workerEmitted && testHit(NODE_CRON_RE, content).hit) {
    const h = testHit(NODE_CRON_RE, content);
    artifacts.push({
      kind: 'worker_definition',
      detail: 'cron schedule',
      file: relPath,
      line: h.line,
    });
  }

  // DB env var detection first — captures the actual env var name for node naming.
  // Checked before library imports so that "REDIS_URL" wins over "Redis client".
  const seenDbTypes = new Set<string>();
  for (const { re, dbType } of DB_ENV_PATTERNS) {
    if (seenDbTypes.has(dbType)) continue;
    const m = re.exec(content);
    if (m?.[1]) {
      const envVarName = m[1];
      artifacts.push({
        kind: 'db_connection',
        detail: `${envVarName} → ${dbType}`,
        file: relPath,
        line: lineAt(content, m.index ?? 0),
        connectionName: envVarName,
      });
      seenDbTypes.add(dbType);
    }
  }

  // DB imports + ORM (library-level detection, fallback for types not found via env vars)
  for (const { re, dbType, detail } of DB_PATTERNS) {
    if (seenDbTypes.has(dbType)) continue;
    const hit = testHit(re, content);
    if (hit.hit) {
      artifacts.push({
        kind: 'db_connection',
        detail: `${detail} → ${dbType}`,
        file: relPath,
        line: hit.line,
      });
      seenDbTypes.add(dbType);
    }
  }

  // DB connection variable names (e.g. `const userDb = new Pool(...)`)
  // Augments connectionName on an already-emitted artifact for the same dbType.
  for (const m of matchAll(content, DB_CONN_VAR_RE.source)) {
    const varName = m[1];
    if (!varName || varName === 'db' || varName === 'client' || varName === 'pool') continue;
    // Find the most recently emitted db_connection for postgres (Pool/Client are pg-specific)
    const existing = [...artifacts].reverse().find(
      (a) => a.kind === 'db_connection' && !a.connectionName && /postgres/i.test(a.detail),
    );
    if (existing) existing.connectionName = varName;
  }

  // Auth middleware
  for (const { re, detail } of AUTH_PATTERNS) {
    const hit = testHit(re, content);
    if (hit.hit) {
      artifacts.push({ kind: 'auth_middleware', detail, file: relPath, line: hit.line });
      break;
    }
  }

  // Service-to-service calls (generic, for drift detection)
  for (const { re, detail } of SERVICE_CALL_PATTERNS) {
    const hit = testHit(re, content);
    if (hit.hit) {
      artifacts.push({ kind: 'service_call', detail, file: relPath, line: hit.line });
      break;
    }
  }

  // External HTTP calls — extract per-destination nodes
  const seenDestinations = new Set<string>();
  for (const m of matchAll(content, EXTERNAL_URL_CALL_RE.source)) {
    const url = m[1];
    if (!url) continue;
    const hostname = hostnameFromUrl(url);
    const label = labelFromHostname(hostname);
    if (seenDestinations.has(label)) continue;
    seenDestinations.add(label);
    artifacts.push({
      kind: 'external_http',
      detail: `outbound ${url}`,
      file: relPath,
      line: lineFromMatch(content, m),
      destination: label,
    });
  }

  // gRPC client targets
  for (const m of matchAll(content, GRPC_TARGET_RE.source)) {
    const target = m[2] ?? '';
    const svcName = m[1] ? m[1].replace(/ServiceClient$/, '').toLowerCase() : target.split(':')[0] ?? 'grpc-svc';
    const label = svcName.replace(/[^a-z0-9-]/g, '-');
    if (seenDestinations.has(label)) continue;
    seenDestinations.add(label);
    artifacts.push({
      kind: 'external_http',
      detail: `gRPC ${target}`,
      file: relPath,
      line: lineFromMatch(content, m),
      destination: label,
    });
  }

  return artifacts;
}
