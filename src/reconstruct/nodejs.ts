/**
 * Node.js / TypeScript source-code pattern analyzer.
 * Detects HTTP routes, DB connections, auth middleware, and service calls
 * using regex scanning — no subprocess or external dependency required.
 */

import type { DetectedArtifact } from './types.js';
import type { ScannedFile } from './file-walker.js';
import { lineFromMatch, matchAll, testHit } from './scan-utils.js';

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

// ---- HTTP route patterns ----------------------------------------------------

const HEALTH_PATH_RE = /^(\/health(?:z|check)?|\/healthy|\/ready|\/live|\/ping|\/status|\/alive)\b/i;

/** Express / Koa / Hono: app.get('/path', ...) or router.post('/path', ...) */
const EXPRESS_ROUTE_RE =
  /(?:app|router|server|route)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;

/** Fastify: fastify.get('/path', ...) */
const FASTIFY_ROUTE_RE =
  /(?:fastify|server)\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`\n]+)['"`]|(?:fastify|server)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;

/** NestJS @Controller + @Get/@Post etc. */
const NEST_CONTROLLER_RE = /@Controller\s*\(\s*['"`]?([^'"`)\n]*?)['"`]?\s*\)/gi;
const NEST_VERB_RE = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\s*\(\s*['"`]?([^'"`)\n]*?)['"`]?\s*\)/gi;

// ---- DB connection patterns -------------------------------------------------

type DbPattern = { re: RegExp; dbType: string; detail: string };

const DB_PATTERNS: DbPattern[] = [
  { re: /(?:require|from)\s*['"`]pg['"`]/, dbType: 'postgres', detail: 'pg (PostgreSQL)' },
  { re: /new\s+Pool\s*\(|new\s+Client\s*\(\s*\{/, dbType: 'postgres', detail: 'pg Pool/Client' },
  { re: /(?:require|from)\s*['"`]@prisma\/client['"`]|PrismaClient/, dbType: 'postgres', detail: 'Prisma ORM' },
  {
    re: /(?:require|from)\s*['"`]typeorm['"`]|createConnection\s*\(\s*\{|DataSource\s*\(\s*\{/,
    dbType: 'postgres',
    detail: 'TypeORM',
  },
  {
    re: /(?:require|from)\s*['"`]sequelize['"`]|new\s+Sequelize\s*\(/,
    dbType: 'postgres',
    detail: 'Sequelize ORM',
  },
  {
    re: /(?:require|from)\s*['"`]mysql2?['"`]/,
    dbType: 'mysql',
    detail: 'mysql/mysql2 driver',
  },
  {
    re: /(?:require|from)\s*['"`]mariadb['"`]/,
    dbType: 'mysql',
    detail: 'mariadb driver',
  },
  {
    re: /(?:require|from)\s*['"`]mongoose['"`]|mongoose\.connect\s*\(/,
    dbType: 'mongodb',
    detail: 'Mongoose (MongoDB)',
  },
  {
    re: /(?:require|from)\s*['"`]mongodb['"`]|MongoClient/,
    dbType: 'mongodb',
    detail: 'MongoDB native driver',
  },
  {
    re: /(?:require|from)\s*['"`](?:redis|ioredis)['"`]|createClient\s*\(\s*\{/,
    dbType: 'cache',
    detail: 'Redis client',
  },
  {
    re: /(?:require|from)\s*['"`]@elastic\/elasticsearch['"`]|new\s+ElasticsearchClient\s*\(/,
    dbType: 'search',
    detail: 'Elasticsearch client',
  },
  {
    re: /(?:require|from)\s*['"`]cassandra-driver['"`]/,
    dbType: 'cassandra',
    detail: 'Cassandra driver',
  },
];

const DB_ENV_PATTERNS: DbPattern[] = [
  { re: /\bDATABASE_URL\b/, dbType: 'postgres', detail: 'DATABASE_URL env var' },
  {
    re: /\b(?:POSTGRES_URL|POSTGRESQL_URL|PGHOST|POSTGRES_HOST)\b/,
    dbType: 'postgres',
    detail: 'Postgres env var',
  },
  { re: /\b(?:MYSQL_URL|MYSQL_HOST|MYSQL_DATABASE)\b/, dbType: 'mysql', detail: 'MySQL env var' },
  {
    re: /\b(?:MONGO(?:DB)?_(?:URI|URL|HOST))\b/,
    dbType: 'mongodb',
    detail: 'MongoDB env var',
  },
  { re: /\b(?:REDIS_URL|REDIS_HOST|REDIS_URI)\b/, dbType: 'cache', detail: 'Redis env var' },
  { re: /\bELASTICSEARCH_URL\b/, dbType: 'search', detail: 'Elasticsearch env var' },
];

// ---- Auth patterns ----------------------------------------------------------

type AuthPattern = { re: RegExp; detail: string };

const AUTH_PATTERNS: AuthPattern[] = [
  { re: /passport\.authenticate\s*\(/, detail: 'Passport.js authenticate()' },
  { re: /(?:require|from)\s*['"`]passport['"`]/, detail: 'Passport.js import' },
  { re: /(?:require|from)\s*['"`]express-jwt['"`]|expressJwt\s*\(/, detail: 'express-jwt middleware' },
  { re: /(?:require|from)\s*['"`]fastify-jwt['"`]|\.register\s*\(\s*fastifyJwt/, detail: 'fastify-jwt plugin' },
  { re: /(?:require|from)\s*['"`]jsonwebtoken['"`]|jwt\.verify\s*\(/, detail: 'jsonwebtoken' },
  { re: /@UseGuards\s*\(/, detail: 'NestJS @UseGuards' },
  { re: /@AuthGuard\s*\(/, detail: 'NestJS @AuthGuard' },
  {
    re: /(?:require|from)\s*['"`]auth0['"`]|new\s+(?:AuthenticationClient|ManagementClient)\s*\(/,
    detail: 'Auth0 SDK',
  },
  { re: /(?:require|from)\s*['"`]@okta\//, detail: 'Okta SDK' },
  {
    re: /(?:require|from)\s*['"`]keycloak-connect['"`]|new\s+Keycloak\s*\(/,
    detail: 'Keycloak Connect',
  },
  { re: /(?:require|from)\s*['"`]amazon-cognito/, detail: 'AWS Cognito SDK' },
  { re: /(?:require|from)\s*['"`]@aws-amplify\/auth['"`]/, detail: 'AWS Amplify Auth' },
  { re: /\.use\s*\(\s*requiresAuth\s*\(/, detail: 'auth middleware registration' },
];

// ---- Service-to-service call patterns --------------------------------------

type SvcCallPattern = { re: RegExp; detail: string };

const SERVICE_CALL_PATTERNS: SvcCallPattern[] = [
  { re: /(?:require|from)\s*['"`]axios['"`]/, detail: 'axios HTTP client' },
  { re: /axios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/, detail: 'axios HTTP call' },
  { re: /(?:require|from)\s*['"`]got['"`]/, detail: 'got HTTP client' },
  { re: /(?:require|from)\s*['"`]node-fetch['"`]/, detail: 'node-fetch' },
  { re: /(?:require|from)\s*['"`]@grpc\/grpc-js['"`]/, detail: 'gRPC client' },
  {
    re: /new\s+\w+ServiceClient\s*\(\s*process\.env\./,
    detail: 'gRPC client from env',
  },
  {
    re: /HttpClient|HttpService|fetch\s*\(\s*(?:process\.env|`https?:\/\/|['"]https?:\/\/)/,
    detail: 'HTTP service client',
  },
];

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

  // DB imports + ORM
  const seenDbTypes = new Set<string>();
  for (const { re, dbType, detail } of [...DB_PATTERNS, ...DB_ENV_PATTERNS]) {
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

  // Auth middleware
  for (const { re, detail } of AUTH_PATTERNS) {
    const hit = testHit(re, content);
    if (hit.hit) {
      artifacts.push({ kind: 'auth_middleware', detail, file: relPath, line: hit.line });
      break;
    }
  }

  // Service-to-service calls
  for (const { re, detail } of SERVICE_CALL_PATTERNS) {
    const hit = testHit(re, content);
    if (hit.hit) {
      artifacts.push({ kind: 'service_call', detail, file: relPath, line: hit.line });
      break;
    }
  }

  return artifacts;
}
