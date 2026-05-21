/**
 * Python source-code pattern analyzer.
 * Covers Flask, FastAPI, Django, DRF, and common DB/auth patterns.
 */

import type { DetectedArtifact } from './types.js';
import type { ScannedFile } from './file-walker.js';
import { lineFromMatch, matchAll, testHit } from './scan-utils.js';

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

const HEALTH_PATH_RE = /^(\/health(?:z|check)?|\/healthy|\/ready|\/live|\/ping|\/status|\/alive)\b/i;

// ---- HTTP route patterns ----------------------------------------------------

/** Flask: @app.route('/path') or @app.route('/path', methods=['GET','POST']) */
const FLASK_ROUTE_RE =
  /@(?:app|blueprint|bp|router|api)\s*\.\s*route\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;

/** FastAPI / APIRouter: @app.get('/path') @router.post('/path') */
const FASTAPI_ROUTE_RE =
  /@(?:app|router|api_router|router_\w+)\s*\.\s*(get|post|put|patch|delete|head|options|trace)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;

/** Django: path('route/', view) or re_path(r'^route/', view) — in urls.py files */
const DJANGO_PATH_RE = /(?:^|\s)(?:re_)?path\s*\(\s*r?['"`]([^'"`\n]+)['"`]/gim;

/** DRF @action decorator */
const DRF_ACTION_RE = /@action\s*\([^)]*url_path\s*=\s*['"`]([^'"`\n]+)['"`]/gi;

// ---- DB patterns ------------------------------------------------------------

type DbPat = { re: RegExp; dbType: string; detail: string };

const DB_PATTERNS: DbPat[] = [
  {
    re: /from\s+django\.db\s+import|from\s+django\.conf\s+import.*DATABASES/,
    dbType: 'postgres',
    detail: 'Django ORM',
  },
  {
    re: /DATABASES\s*=\s*\{/,
    dbType: 'postgres',
    detail: 'Django DATABASES setting',
  },
  {
    re: /from\s+sqlalchemy|import\s+sqlalchemy|create_engine\s*\(/,
    dbType: 'postgres',
    detail: 'SQLAlchemy',
  },
  {
    re: /from\s+tortoise|import\s+tortoise/,
    dbType: 'postgres',
    detail: 'Tortoise ORM',
  },
  {
    re: /import\s+psycopg2|from\s+psycopg2/,
    dbType: 'postgres',
    detail: 'psycopg2 (PostgreSQL)',
  },
  {
    re: /import\s+asyncpg|from\s+asyncpg/,
    dbType: 'postgres',
    detail: 'asyncpg (PostgreSQL)',
  },
  {
    re: /import\s+pymysql|import\s+MySQLdb|mysql\.connector/,
    dbType: 'mysql',
    detail: 'MySQL driver',
  },
  {
    re: /import\s+pymongo|from\s+pymongo|MongoClient\s*\(/,
    dbType: 'mongodb',
    detail: 'PyMongo (MongoDB)',
  },
  {
    re: /import\s+motor|from\s+motor/,
    dbType: 'mongodb',
    detail: 'motor (async MongoDB)',
  },
  {
    re: /import\s+redis|from\s+redis|redis\.Redis\s*\(/,
    dbType: 'cache',
    detail: 'redis-py',
  },
  {
    re: /import\s+aioredis|from\s+aioredis/,
    dbType: 'cache',
    detail: 'aioredis (async Redis)',
  },
  {
    re: /import\s+elasticsearch|from\s+elasticsearch/,
    dbType: 'search',
    detail: 'elasticsearch-py',
  },
];

const DB_ENV_PATTERNS: DbPat[] = [
  { re: /\bDATABASE_URL\b/, dbType: 'postgres', detail: 'DATABASE_URL env var' },
  { re: /\b(?:POSTGRES_URL|PGHOST|POSTGRESQL_URL)\b/, dbType: 'postgres', detail: 'Postgres env var' },
  { re: /\bMYSQL_(?:URL|HOST|DATABASE)\b/, dbType: 'mysql', detail: 'MySQL env var' },
  { re: /\bMONGO(?:DB)?_(?:URI|URL|HOST)\b/, dbType: 'mongodb', detail: 'MongoDB env var' },
  { re: /\bREDIS_(?:URL|HOST|URI)\b/, dbType: 'cache', detail: 'Redis env var' },
];

// ---- Auth patterns ----------------------------------------------------------

type AuthPat = { re: RegExp; detail: string };

const AUTH_PATTERNS: AuthPat[] = [
  { re: /@login_required\b/, detail: 'Django @login_required' },
  { re: /@permission_required\s*\(/, detail: 'Django @permission_required' },
  { re: /from\s+rest_framework.*permissions|IsAuthenticated|IsAdminUser/, detail: 'DRF permissions' },
  { re: /@jwt_required|@fresh_jwt_required|get_jwt_identity\s*\(/, detail: 'Flask-JWT-Extended' },
  { re: /Depends\s*\(\s*get_current_user|oauth2_scheme|HTTPBearer/, detail: 'FastAPI auth dependency' },
  { re: /from\s+authlib|import\s+authlib/, detail: 'Authlib' },
  { re: /from\s+python_jose|import\s+jwt\b|jwt\.decode\s*\(/, detail: 'JWT decode' },
  { re: /from\s+keycloak|KeycloakOpenID\s*\(/, detail: 'python-keycloak' },
  { re: /from\s+okta|import\s+okta/, detail: 'Okta Python SDK' },
  { re: /from\s+auth0|Auth0\s*\(/, detail: 'Auth0 Python SDK' },
  { re: /from\s+cognito|CognitoIdentityProviderClient/, detail: 'AWS Cognito' },
  { re: /HTTPBearer|OAuth2PasswordBearer|APIKeyHeader/, detail: 'FastAPI security scheme' },
];

// ---- Service call patterns --------------------------------------------------

const SERVICE_CALL_PATTERNS: AuthPat[] = [
  { re: /import\s+requests\b|from\s+requests\b/, detail: 'requests HTTP client' },
  { re: /import\s+httpx\b|from\s+httpx\b/, detail: 'httpx HTTP client' },
  { re: /import\s+aiohttp\b|from\s+aiohttp\b/, detail: 'aiohttp HTTP client' },
  { re: /import\s+grpc\b|from\s+grpc\b/, detail: 'gRPC client' },
];

// ---- analysis entry point ---------------------------------------------------

export function analyzePythonFile(file: ScannedFile): DetectedArtifact[] {
  const artifacts: DetectedArtifact[] = [];
  const { relPath, content } = file;

  // Flask routes
  for (const m of matchAll(file.content, FLASK_ROUTE_RE.source)) {
    const path = m[1] ?? '/';
    const kind = HEALTH_PATH_RE.test(path) ? 'health_route' : 'http_route';
    pushRouteArtifact(artifacts, file, m, kind, `@route("${path}")`);
  }

  // FastAPI routes
  for (const m of matchAll(file.content, FASTAPI_ROUTE_RE.source)) {
    const method = (m[1] ?? 'GET').toUpperCase();
    const path = m[2] ?? '/';
    const kind = HEALTH_PATH_RE.test(path) ? 'health_route' : 'http_route';
    pushRouteArtifact(artifacts, file, m, kind, `@${method.toLowerCase()}("${path}")`);
  }

  // Django urls.py patterns
  if (/urls?\.py$/i.test(relPath)) {
    for (const m of matchAll(file.content, DJANGO_PATH_RE.source)) {
      const path = m[1] ?? '';
      if (!path) continue;
      const kind = HEALTH_PATH_RE.test(`/${path}`) ? 'health_route' : 'http_route';
      pushRouteArtifact(artifacts, file, m, kind, `path("${path}")`);
    }
  }

  // DRF @action
  for (const m of matchAll(file.content, DRF_ACTION_RE.source)) {
    pushRouteArtifact(
      artifacts,
      file,
      m,
      'http_route',
      `@action(url_path="${m[1] ?? ''}")`,
    );
  }

  // DB connections
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

  // Auth
  for (const { re, detail } of AUTH_PATTERNS) {
    const hit = testHit(re, content);
    if (hit.hit) {
      artifacts.push({ kind: 'auth_middleware', detail, file: relPath, line: hit.line });
      break;
    }
  }

  // Service calls
  for (const { re, detail } of SERVICE_CALL_PATTERNS) {
    const hit = testHit(re, content);
    if (hit.hit) {
      artifacts.push({ kind: 'service_call', detail, file: relPath, line: hit.line });
      break;
    }
  }

  return artifacts;
}
