/**
 * C# / ASP.NET Core source-code pattern analyzer.
 * Covers controller attributes, minimal API endpoints, EF Core, Dapper, and auth patterns.
 * Uses file scanning — no Roslyn/dotnet subprocess required.
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

/** Controller attributes: [HttpGet], [HttpPost("/path")], [Route("path")] */
const CONTROLLER_VERB_RE =
  /\[(?:Http(?:Get|Post|Put|Patch|Delete|Head|Options)|Route)\s*(?:\(\s*["']([^"'\n]*)["']\s*\))?\]/gi;

/** Minimal API: app.MapGet("/path", ...) or endpoints.MapPost(...) */
const MINIMAL_API_RE =
  /\.\s*Map(?:Get|Post|Put|Patch|Delete|Methods)\s*\(\s*["']([^"'\n]+)["']/gi;

/** [ApiController] marker — indicates this file defines a web API controller */
const API_CONTROLLER_RE = /\[ApiController\]/i;

// ---- DB patterns ------------------------------------------------------------

type DbPat = { re: RegExp; dbType: string; detail: string };

const DB_PATTERNS: DbPat[] = [
  {
    re: /:\s*DbContext\b|services\s*\.\s*AddDbContext\s*<|OnConfiguring\s*\(/,
    dbType: 'postgres',
    detail: 'Entity Framework Core DbContext',
  },
  {
    re: /NpgsqlConnection\s*\(|UseNpgsql\s*\(/,
    dbType: 'postgres',
    detail: 'Npgsql (PostgreSQL)',
  },
  {
    re: /SqlConnection\s*\(|services\s*\.\s*AddSqlServer\s*\(/,
    dbType: 'sqlserver',
    detail: 'SQL Server (ADO.NET / EF)',
  },
  {
    re: /MySqlConnection\s*\(|UseMySql\s*\(/,
    dbType: 'mysql',
    detail: 'MySQL connector',
  },
  {
    re: /MongoClient\s*\(|IMongoDatabase\b/,
    dbType: 'mongodb',
    detail: 'MongoDB .NET driver',
  },
  {
    re: /ConnectionMultiplexer\s*\.\s*Connect|IDatabase\s+\w+\s*=\s*.*GetDatabase/,
    dbType: 'cache',
    detail: 'StackExchange.Redis',
  },
  {
    re: /IDbConnection\b|SqlMapper\.|Dapper\./,
    dbType: 'postgres',
    detail: 'Dapper micro-ORM',
  },
  {
    re: /ElasticClient\s*\(|services\s*\.\s*AddElasticsearch/,
    dbType: 'search',
    detail: 'NEST / Elastic.Clients (Elasticsearch)',
  },
];

const DB_ENV_PATTERNS: DbPat[] = [
  {
    re: /["'](?:ConnectionStrings:)?DATABASE_URL["']|GetConnectionString\s*\(\s*["'][^"']+["']\s*\)/,
    dbType: 'postgres',
    detail: 'Connection string reference',
  },
  {
    re: /\bConnectionStrings\b|\bGetConnectionString\b/,
    dbType: 'postgres',
    detail: 'Connection string config',
  },
];

// ---- Auth patterns ----------------------------------------------------------

type AuthPat = { re: RegExp; detail: string };

const AUTH_PATTERNS: AuthPat[] = [
  { re: /\[Authorize(?:\s*\(|\s*\])/i, detail: '[Authorize] attribute' },
  { re: /services\s*\.\s*AddAuthentication\s*\(/, detail: 'AddAuthentication()' },
  { re: /UseAuthentication\s*\(\s*\)/, detail: 'UseAuthentication() middleware' },
  { re: /AddJwtBearer\s*\(/, detail: 'JWT Bearer authentication' },
  { re: /AddIdentity\s*</, detail: 'ASP.NET Core Identity' },
  { re: /AddOpenIdConnect\s*\(/, detail: 'OpenID Connect' },
  { re: /Auth0Client\s*\(|AddAuth0WebAppAuthentication/, detail: 'Auth0 SDK' },
  { re: /OktaWebApiOptions|services\.AddOktaWebApi/, detail: 'Okta SDK' },
  { re: /KeycloakAuthenticationOptions|AddKeycloakAuthentication/, detail: 'Keycloak auth' },
  { re: /AmazonCognitoIdentityClient|AddCognito/, detail: 'AWS Cognito' },
];

// ---- Service call patterns --------------------------------------------------

const SERVICE_CALL_PATTERNS: AuthPat[] = [
  { re: /HttpClient\s+\w+|AddHttpClient\s*<|IHttpClientFactory/, detail: 'HttpClient / IHttpClientFactory' },
  { re: /new\s+GrpcChannel|GrpcChannel\s*\.\s*ForAddress/, detail: 'gRPC channel (Grpc.Net.Client)' },
  { re: /RestClient\s*\(|new\s+RestSharp\b/, detail: 'RestSharp HTTP client' },
];

// ---- analysis entry point ---------------------------------------------------

export function analyzeCsharpFile(file: ScannedFile): DetectedArtifact[] {
  const artifacts: DetectedArtifact[] = [];
  const { relPath, content } = file;

  // Minimal API endpoints
  for (const m of matchAll(file.content, MINIMAL_API_RE.source)) {
    const path = m[1] ?? '/';
    const kind = HEALTH_PATH_RE.test(path) ? 'health_route' : 'http_route';
    pushRouteArtifact(artifacts, file, m, kind, `Map*(\"${path}\")`);
  }

  // Controller attributes — only if [ApiController] is also present
  if (testHit(API_CONTROLLER_RE, content).hit) {
    const verbMatches = matchAll(file.content, CONTROLLER_VERB_RE.source);
    for (const m of verbMatches) {
      const path = m[1] ?? '';
      const kind = path && HEALTH_PATH_RE.test(`/${path}`) ? 'health_route' : 'http_route';
      pushRouteArtifact(
        artifacts,
        file,
        m,
        kind,
        path ? `[Route("${path}")]` : '[HttpVerb]',
      );
    }
    if (verbMatches.length === 0) {
      const ctrlHit = testHit(API_CONTROLLER_RE, content);
      artifacts.push({
        kind: 'http_route',
        detail: '[ApiController]',
        file: relPath,
        line: ctrlHit.line,
      });
    }
  }

  // DB
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
