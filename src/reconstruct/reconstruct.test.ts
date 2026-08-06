import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconstructIrFromCodebase } from './reconstruct.js';
import { compareImplementationDrift } from '../ir-drift-impl.js';
import { shouldExclude } from './file-walker.js';
import { analyzeNodejsFile } from './nodejs.js';
import { analyzePythonFile } from './python.js';
import { analyzeCsharpFile } from './csharp.js';

// ---- helpers ----------------------------------------------------------------

let tmpDirs: string[] = [];

async function makeTmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'archrad-reconstruct-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

// ---- 1. Simple Express + Postgres -------------------------------------------

describe('Express + Postgres reconstruction', () => {
  it('detects HTTP node, postgres node, and edge between them', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "api" }',
      'src/index.ts': `
import express from 'express';
import { Pool } from 'pg';
const app = express();
const db = new Pool({ connectionString: process.env.DATABASE_URL });
app.get('/users', async (req, res) => { const r = await db.query('SELECT * FROM users'); res.json(r.rows); });
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(3000);
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    expect(result.language).toBe('nodejs');

    const artifacts = result.artifacts;
    const httpRoutes = artifacts.filter((a) => a.kind === 'http_route');
    const healthRoutes = artifacts.filter((a) => a.kind === 'health_route');
    const dbConns = artifacts.filter((a) => a.kind === 'db_connection');

    expect(httpRoutes.length).toBeGreaterThanOrEqual(1);
    expect(healthRoutes.length).toBeGreaterThanOrEqual(1);
    expect(dbConns.length).toBeGreaterThanOrEqual(1);
    expect(dbConns.some((a) => /postgres/i.test(a.detail))).toBe(true);

    // Reconstructed IR should have HTTP node + DB node + edge
    const g = result.ir.graph as { nodes: { id: string; type: string }[]; edges: { from: string; to: string }[] };
    const httpNode = g.nodes.find((n) => n.type === 'gateway' || n.type === 'service');
    const dbNode = g.nodes.find((n) => n.type === 'postgres');
    expect(httpNode).toBeDefined();
    expect(dbNode).toBeDefined();
    expect(g.edges.some((e) => e.from === httpNode?.id && e.to === dbNode?.id)).toBe(true);

    const gateway = g.nodes.find((n) => n.type === 'gateway');
    expect((gateway as { config?: { url?: string } })?.config?.url).toBe('/health');
  });
});

// ---- 2. FastAPI with auth middleware ----------------------------------------

describe('FastAPI + auth reconstruction', () => {
  it('detects auth node connected to HTTP entry', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'requirements.txt': 'fastapi\nuvicorn\npython-jose\n',
      'app/main.py': `
from fastapi import FastAPI, Depends
from fastapi.security import OAuth2PasswordBearer
from jose import jwt

app = FastAPI()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

@app.get("/items")
async def read_items(token: str = Depends(oauth2_scheme)):
    return {"items": []}

@app.get("/health")
async def health():
    return {"status": "ok"}
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'python' });
    expect(result.language).toBe('python');

    const authArtifacts = result.artifacts.filter((a) => a.kind === 'auth_middleware');
    const httpRoutes = result.artifacts.filter((a) => a.kind === 'http_route' || a.kind === 'health_route');
    expect(authArtifacts.length).toBeGreaterThanOrEqual(1);
    expect(httpRoutes.length).toBeGreaterThanOrEqual(1);

    const g = result.ir.graph as { nodes: { id: string; type: string }[]; edges: { from: string; to: string }[] };
    const authNode = g.nodes.find((n) => n.type === 'auth');
    expect(authNode).toBeDefined();
    // Edge from primary service to auth node
    const primaryNode = g.nodes.find((n) => n.type === 'gateway' || n.type === 'service');
    expect(primaryNode).toBeDefined();
    expect(g.edges.some((e) => e.from === primaryNode?.id && e.to === authNode?.id)).toBe(true);
  });
});

// ---- 3. Implementation drift prerequisites ----------------------------------

describe('implementation drift prerequisites (IR-DRIFT-IMPL-000)', () => {
  it('emits IR-DRIFT-IMPL-000 when authored IR cannot be parsed for lint graph comparison', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "api" }',
      'src/x.js': `const axios=require('axios');axios.get('http://x');`,
    });

    const badIr = { graph: { nodes: [], edges: [] } };

    const reconstructed = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    const findings = compareImplementationDrift(badIr, reconstructed);
    expect(findings.some((f) => f.code === 'IR-DRIFT-IMPL-000')).toBe(true);
    expect(findings.some((f) => f.code === 'IR-DRIFT-IMPL-001')).toBe(false);
  });
});

describe('IR-DRIFT-IMPL-002 vs 004 deduplication', () => {
  it('emits only IR-DRIFT-IMPL-004 when HTTP routes exist in code but authored IR has no HTTP nodes', () => {
    const reconstructed = {
      artifacts: [{ kind: 'http_route' as const, detail: 'GET /api', file: 'a.js' }],
      ir: {},
      language: 'nodejs' as const,
      serviceName: 'x',
      warnings: [],
    };
    const ir = { graph: { nodes: [{ id: 's', type: 'service' }], edges: [] } };
    const findings = compareImplementationDrift(ir, reconstructed);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('IR-DRIFT-IMPL-004');
    expect(codes).not.toContain('IR-DRIFT-IMPL-002');
  });

  it('emits IR-DRIFT-IMPL-002 when only health routes exist in code without HTTP nodes in IR', () => {
    const reconstructed = {
      artifacts: [{ kind: 'health_route' as const, detail: 'GET /healthz', file: 'a.js' }],
      ir: {},
      language: 'nodejs' as const,
      serviceName: 'x',
      warnings: [],
    };
    const ir = { graph: { nodes: [{ id: 's', type: 'service' }], edges: [] } };
    const findings = compareImplementationDrift(ir, reconstructed);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('IR-DRIFT-IMPL-002');
    expect(codes).not.toContain('IR-DRIFT-IMPL-004');
  });
});

describe('Dummy IR attack detection (IR-DRIFT-IMPL-003)', () => {
  it('fires IR-DRIFT-IMPL-003 when code has DB access but authored IR has no DB edges', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "sneaky-api" }',
      'src/app.ts': `
import express from 'express';
import { Pool } from 'pg';  // direct DB access hidden from IR
const app = express();
const db = new Pool({ connectionString: process.env.DATABASE_URL });
app.get('/orders', async (req, res) => {
  const rows = await db.query('SELECT * FROM orders');
  res.json(rows.rows);
});
app.listen(4000);
`,
    });

    // Authored IR: looks clean — no DB edge, only a service node
    const cleanIr = {
      graph: {
        nodes: [
          { id: 'api', type: 'gateway', name: 'API Gateway' },
          // Deliberately no DB node in the authored IR
        ],
        edges: [],
      },
    };

    const reconstructed = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    const findings = compareImplementationDrift(cleanIr, reconstructed);

    const driftFindings = findings.filter((f) => f.code === 'IR-DRIFT-IMPL-003');
    expect(driftFindings.length).toBe(1);
    expect(driftFindings[0]?.severity).toBe('error');
  });
});

describe('IR-DRIFT-IMPL-004 / 005 / 006', () => {
  it('fires IR-DRIFT-IMPL-004 for undocumented HTTP entry points', () => {
    const reconstructed = {
      artifacts: [{ kind: 'http_route' as const, detail: 'GET /orders', file: 'src/app.ts', line: 4 }],
      ir: {},
      language: 'nodejs' as const,
      serviceName: 'api',
      warnings: [],
    };
    const ir = {
      graph: {
        nodes: [{ id: 'worker', type: 'service', name: 'Background worker' }],
        edges: [],
      },
    };
    const findings = compareImplementationDrift(ir, reconstructed);
    expect(findings.some((f) => f.code === 'IR-DRIFT-IMPL-004' && f.severity === 'error')).toBe(true);
  });

  it('fires IR-DRIFT-IMPL-005 when outbound calls exist but IR has no service edges', () => {
    const reconstructed = {
      artifacts: [
        {
          kind: 'service_call' as const,
          detail: 'axios HTTP client',
          file: 'src/client.ts',
          line: 2,
        },
      ],
      ir: {},
      language: 'nodejs' as const,
      serviceName: 'api',
      warnings: [],
    };
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'gateway', name: 'API' }],
        edges: [],
      },
    };
    const findings = compareImplementationDrift(ir, reconstructed);
    expect(findings.some((f) => f.code === 'IR-DRIFT-IMPL-005' && f.severity === 'warning')).toBe(true);
  });

  it('still fires IR-DRIFT-IMPL-005 when IR only has internal gateway→service layering edges', () => {
    const reconstructed = {
      artifacts: [
        {
          kind: 'service_call' as const,
          detail: 'axios HTTP client',
          file: 'src/client.ts',
          line: 2,
        },
      ],
      ir: {},
      language: 'nodejs' as const,
      serviceName: 'api',
      warnings: [],
    };
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'gateway', name: 'API' },
          { id: 'domain', type: 'service', name: 'Domain layer' },
        ],
        edges: [{ id: 'e1', from: 'api', to: 'domain' }],
      },
    };
    const findings = compareImplementationDrift(ir, reconstructed);
    expect(findings.some((f) => f.code === 'IR-DRIFT-IMPL-005')).toBe(true);
  });

  it('suppresses IR-DRIFT-IMPL-005 when IR documents an outbound serviceCall edge', () => {
    const reconstructed = {
      artifacts: [
        {
          kind: 'service_call' as const,
          detail: 'axios HTTP client',
          file: 'src/client.ts',
          line: 2,
        },
      ],
      ir: {},
      language: 'nodejs' as const,
      serviceName: 'api',
      warnings: [],
    };
    const ir = {
      graph: {
        nodes: [
          { id: 'api', type: 'gateway', name: 'API' },
          { id: 'billing', type: 'service', name: 'Billing API' },
        ],
        edges: [
          {
            id: 'e1',
            from: 'api',
            to: 'billing',
            metadata: { relation: 'serviceCall', protocol: 'http', async: false },
          },
        ],
      },
    };
    const findings = compareImplementationDrift(ir, reconstructed);
    expect(findings.some((f) => f.code === 'IR-DRIFT-IMPL-005')).toBe(false);
  });

  it('fires IR-DRIFT-IMPL-006 when auth middleware exists in code but not in IR', () => {
    const reconstructed = {
      artifacts: [
        {
          kind: 'auth_middleware' as const,
          detail: 'Passport.js authenticate()',
          file: 'src/auth.ts',
          line: 8,
        },
      ],
      ir: {},
      language: 'nodejs' as const,
      serviceName: 'api',
      warnings: [],
    };
    const ir = {
      graph: {
        nodes: [{ id: 'api', type: 'gateway', name: 'API' }],
        edges: [],
      },
    };
    const findings = compareImplementationDrift(ir, reconstructed);
    expect(findings.some((f) => f.code === 'IR-DRIFT-IMPL-006' && f.severity === 'info')).toBe(true);
  });
});

// ---- 4. Test file exclusion -------------------------------------------------

describe('Test file exclusion', () => {
  it('does not include routes defined in test files', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "myapp" }',
      // Real source file — should be included
      'src/routes.ts': `
import express from 'express';
const router = express.Router();
router.get('/real-endpoint', (req, res) => res.json({ ok: true }));
`,
      // Test file — must be excluded
      'src/routes.test.ts': `
import express from 'express';
const app = express();
app.get('/test-only-route', () => {});
app.post('/test-only-post', () => {});
`,
      // __tests__ directory — must be excluded
      '__tests__/integration.ts': `
import express from 'express';
const app = express();
app.get('/integration-route', () => {});
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });

    const allRouteDetails = result.artifacts
      .filter((a) => a.kind === 'http_route' || a.kind === 'health_route')
      .map((a) => a.detail);

    expect(allRouteDetails.some((d) => d.includes('/real-endpoint'))).toBe(true);
    expect(allRouteDetails.some((d) => d.includes('/test-only-route'))).toBe(false);
    expect(allRouteDetails.some((d) => d.includes('/test-only-post'))).toBe(false);
    expect(allRouteDetails.some((d) => d.includes('/integration-route'))).toBe(false);
  });

  it('shouldExclude correctly flags test files and directories', () => {
    expect(shouldExclude('src/routes.test.ts')).toBe(true);
    expect(shouldExclude('src/routes.spec.ts')).toBe(true);
    expect(shouldExclude('__tests__/foo.ts')).toBe(true);
    expect(shouldExclude('tests/integration.ts')).toBe(true);
    expect(shouldExclude('src/routes.ts')).toBe(false);
    expect(shouldExclude('src/app.ts')).toBe(false);
  });
});

// ---- 5. C# minimal API ------------------------------------------------------

describe('C# minimal API reconstruction', () => {
  it('detects HTTP endpoints via MapGet/MapPost patterns', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'MyApi.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
      'Program.cs': `
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(opt =>
    opt.UseNpgsql(builder.Configuration.GetConnectionString("Database")));

var app = builder.Build();
app.MapGet("/products", (AppDbContext db) => db.Products.ToListAsync());
app.MapPost("/products", (Product p, AppDbContext db) => { db.Products.Add(p); });
app.MapGet("/health", () => Results.Ok(new { status = "healthy" }));
app.Run();
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'csharp' });
    expect(result.language).toBe('csharp');

    const httpRoutes = result.artifacts.filter((a) => a.kind === 'http_route');
    const healthRoutes = result.artifacts.filter((a) => a.kind === 'health_route');
    const dbConns = result.artifacts.filter((a) => a.kind === 'db_connection');

    expect(httpRoutes.length).toBeGreaterThanOrEqual(1);
    expect(healthRoutes.length).toBeGreaterThanOrEqual(1);
    expect(dbConns.length).toBeGreaterThanOrEqual(1);
    expect(dbConns.some((a) => /postgres|npgsql|ef core/i.test(a.detail))).toBe(true);
  });
});

// ---- unit tests for individual analyzers ------------------------------------

describe('analyzeNodejsFile unit tests', () => {
  it('detects NestJS @Get decorator as http_route', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/users.controller.ts',
      content: `
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(@Param('id') id: string) {}
  @Post()
  create(@Body() dto: CreateUserDto) {}
}
`,
    });
    expect(artifacts.some((a) => a.kind === 'http_route')).toBe(true);
  });

  it('does not treat a bare `import passport` as auth_middleware', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/auth.ts',
      content: `import passport from 'passport';\nexport { passport };\n`,
    });
    expect(artifacts.some((a) => a.kind === 'auth_middleware')).toBe(false);
  });

  it('detects passport usage (authenticate/initialize) as auth_middleware', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/auth.ts',
      content: `import passport from 'passport';\napp.use(passport.initialize());\napp.get('/me', passport.authenticate('jwt'), handler);\n`,
    });
    expect(artifacts.some((a) => a.kind === 'auth_middleware')).toBe(true);
  });

  it('detects DATABASE_URL env var as db_connection', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/db.ts',
      content: `
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
`,
    });
    expect(artifacts.some((a) => a.kind === 'db_connection' && /postgres/i.test(a.detail))).toBe(true);
  });

  it('classifies /healthz route as health_route', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/app.ts',
      content: `app.get('/healthz', (_req, res) => res.json({ ok: true }));`,
    });
    expect(artifacts.some((a) => a.kind === 'health_route')).toBe(true);
  });

  it('detects a Fastify object-form route on any receiver name', () => {
    // Fastify's canonical liveness probe. The receiver is `app`, not `fastify`,
    // and the route is declared as an object — the form real Fastify apps use.
    const artifacts = analyzeNodejsFile({
      relPath: 'src/app.ts',
      content: `
  app.route({
    url: '/live',
    method: 'GET',
    logLevel: 'warn',
    schema: { hide: true },
    handler: (_request, reply) => reply.status(200).send({ status: 'OK' }),
  })
`,
    });
    expect(artifacts.some((a) => a.kind === 'health_route')).toBe(true);
  });

  it('detects a non-health Fastify object-form route as http_route', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/routes.ts',
      content: `server.route({ method: 'POST', url: '/v1/users', handler })`,
    });
    expect(artifacts.some((a) => a.kind === 'http_route')).toBe(true);
    expect(artifacts.some((a) => a.kind === 'health_route')).toBe(false);
  });

  it('ignores a .route({}) call that declares no url', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/misc.ts',
      content: `thing.route({ method: 'GET', handler })`,
    });
    expect(artifacts.some((a) => a.kind === 'http_route' || a.kind === 'health_route')).toBe(false);
  });

  it('detects the scoped @fastify/jwt plugin as auth_middleware', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/app.ts',
      content: `import fastifyJwt from '@fastify/jwt';\nawait app.register(fastifyJwt, { secret });\n`,
    });
    expect(artifacts.some((a) => a.kind === 'auth_middleware')).toBe(true);
  });

  it('detects the fastify jwtVerify() decorator as auth_middleware', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/plugins/jwtTokenPlugin.ts',
      content: `export const jwtTokenPlugin = fp(async (app) => {\n  await request.jwtVerify()\n})\n`,
    });
    expect(artifacts.some((a) => a.kind === 'auth_middleware')).toBe(true);
  });

  it('records 1-based line numbers on detected artifacts', () => {
    const content = [
      'import express from "express";',
      'const app = express();',
      "app.get('/users', (_req, res) => res.json([]));",
    ].join('\n');
    const artifacts = analyzeNodejsFile({ relPath: 'src/app.ts', content });
    const route = artifacts.find((a) => a.kind === 'http_route');
    expect(route?.line).toBe(3);
  });

  it('maps cassandra-driver to cassandra db type', () => {
    const artifacts = analyzeNodejsFile({
      relPath: 'src/db.ts',
      content: `import { Client } from 'cassandra-driver';`,
    });
    expect(
      artifacts.some((a) => a.kind === 'db_connection' && /cassandra/i.test(a.detail)),
    ).toBe(true);
  });
});

describe('analyzePythonFile unit tests', () => {
  it('detects FastAPI @app.get route', () => {
    const artifacts = analyzePythonFile({
      relPath: 'app/main.py',
      content: `
from fastapi import FastAPI
app = FastAPI()
@app.get("/items/{item_id}")
def read_item(item_id: int): pass
`,
    });
    expect(artifacts.some((a) => a.kind === 'http_route')).toBe(true);
  });

  it('detects @login_required as auth_middleware', () => {
    const artifacts = analyzePythonFile({
      relPath: 'views.py',
      content: `
from django.contrib.auth.decorators import login_required
@login_required
def my_view(request): pass
`,
    });
    expect(artifacts.some((a) => a.kind === 'auth_middleware')).toBe(true);
  });
});

describe('analyzeCsharpFile unit tests', () => {
  it('detects [HttpGet] on [ApiController] as http_route', () => {
    const artifacts = analyzeCsharpFile({
      relPath: 'Controllers/ItemsController.cs',
      content: `
[ApiController]
[Route("[controller]")]
public class ItemsController : ControllerBase {
  [HttpGet("{id}")]
  public IActionResult Get(int id) => Ok();
  [HttpPost]
  public IActionResult Create([FromBody] Item item) => Ok();
}
`,
    });
    expect(artifacts.some((a) => a.kind === 'http_route')).toBe(true);
  });

  it('detects [Authorize] as auth_middleware', () => {
    const artifacts = analyzeCsharpFile({
      relPath: 'Controllers/SecureController.cs',
      content: `
[ApiController]
[Authorize]
public class SecureController : ControllerBase {
  [HttpGet]
  public IActionResult Get() => Ok();
}
`,
    });
    expect(artifacts.some((a) => a.kind === 'auth_middleware')).toBe(true);
  });

  it('maps SqlConnection to sqlserver db type', () => {
    const artifacts = analyzeCsharpFile({
      relPath: 'Data/Repo.cs',
      content: `
using System.Data.SqlClient;
var conn = new SqlConnection("Server=.;Database=App;");
`,
    });
    expect(
      artifacts.some((a) => a.kind === 'db_connection' && /sqlserver/i.test(a.detail)),
    ).toBe(true);
  });
});

// ============================================================================
// Integration tests for service decomposition (Issue 1–4 requirements)
// ============================================================================

// ---- D1. Express three-route-file decomposition ----------------------------

describe('Express multi-route decomposition: three route files → three service nodes', () => {
  it('produces a gateway + 3 service nodes, not one big gateway', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "shop-api" }',
      'index.ts': `
import express from 'express';
import usersRouter from './routes/users.js';
import paymentsRouter from './routes/payments.js';
import reportsRouter from './routes/reports.js';
const app = express();
app.use('/users', usersRouter);
app.use('/payments', paymentsRouter);
app.use('/reports', reportsRouter);
app.listen(3000);
`,
      'routes/users.ts': `
import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => res.json([]));
router.post('/', (req, res) => res.json({ ok: true }));
module.exports = router;
`,
      'routes/payments.ts': `
import { Router } from 'express';
const router = Router();
router.post('/charge', (req, res) => res.json({ ok: true }));
router.get('/history', (req, res) => res.json([]));
module.exports = router;
`,
      'routes/reports.ts': `
import { Router } from 'express';
const router = Router();
router.get('/summary', (req, res) => res.json({}));
module.exports = router;
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    const g = result.ir.graph as { nodes: { id: string; type: string; name: string }[]; edges: { from: string; to: string }[] };

    const serviceNodes = g.nodes.filter((n) => n.type === 'service');
    const gatewayNodes = g.nodes.filter((n) => n.type === 'gateway');

    expect(gatewayNodes.length).toBe(1);
    expect(serviceNodes.length).toBe(3);

    const names = serviceNodes.map((n) => n.name);
    expect(names).toContain('users');
    expect(names).toContain('payments');
    expect(names).toContain('reports');

    // Gateway should have edges to all three services
    const gwId = gatewayNodes[0]!.id;
    const svcIds = serviceNodes.map((n) => n.id);
    for (const svcId of svcIds) {
      expect(g.edges.some((e) => e.from === gwId && e.to === svcId)).toBe(true);
    }
  });

  it('collapses the same three route files into one service node with singleService', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "shop-api" }',
      'index.ts': `
import express from 'express';
import usersRouter from './routes/users.js';
const app = express();
app.use('/users', usersRouter);
app.listen(3000);
`,
      'routes/users.ts': `
import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => res.json([]));
module.exports = router;
`,
      'routes/orders.ts': `
import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => res.json([]));
module.exports = router;
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs', singleService: true });
    const g = result.ir.graph as { nodes: { type: string }[] };
    // No route-file decomposition: a single primary node, no separate service nodes.
    expect(g.nodes.filter((n) => n.type === 'service')).toHaveLength(0);
    expect(g.nodes.filter((n) => n.type === 'gateway')).toHaveLength(1);
  });
});

// ---- D2. NestJS controller decomposition -----------------------------------

describe('NestJS controller decomposition: three controllers → three service nodes', () => {
  it('detects *.controller.ts files as distinct service nodes', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "nest-api" }',
      'src/main.ts': `
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
`,
      'src/users/users.controller.ts': `
import { Controller, Get, Post, Param, Body } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get() findAll() { return []; }
  @Post() create(@Body() dto: any) { return dto; }
  @Get(':id') findOne(@Param('id') id: string) { return { id }; }
}
`,
      'src/payments/payments.controller.ts': `
import { Controller, Get, Post } from '@nestjs/common';
@Controller('payments')
export class PaymentsController {
  @Post('charge') charge() { return {}; }
  @Get('history') history() { return []; }
}
`,
      'src/reports/reports.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('reports')
export class ReportsController {
  @Get('summary') summary() { return {}; }
}
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    const g = result.ir.graph as { nodes: { id: string; type: string; name: string }[]; edges: unknown[] };

    const serviceNodes = g.nodes.filter((n) => n.type === 'service');
    const gatewayNodes = g.nodes.filter((n) => n.type === 'gateway');

    expect(gatewayNodes.length).toBe(1);
    expect(serviceNodes.length).toBe(3);

    const names = serviceNodes.map((n) => n.name);
    expect(names).toContain('users.controller');
    expect(names).toContain('payments.controller');
    expect(names).toContain('reports.controller');
  });
});

// ---- D3. HTTP routes + BullMQ worker ---------------------------------------

describe('HTTP routes + BullMQ worker → separate service and worker nodes', () => {
  it('produces a gateway, service node for routes, and worker node for queue consumer', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "job-api" }',
      'index.ts': `
import express from 'express';
import apiRouter from './routes/api.js';
const app = express();
app.use('/api', apiRouter);
app.listen(4000);
`,
      'routes/api.ts': `
import { Router } from 'express';
const router = Router();
router.post('/jobs', (req, res) => res.json({ queued: true }));
router.get('/status', (req, res) => res.json({ ok: true }));
module.exports = router;
`,
      'worker.ts': `
import { Worker } from 'bullmq';
const worker = new Worker('jobs', async (job) => {
  console.log('processing', job.data);
  return { done: true };
});
worker.on('completed', (job) => console.log('done', job.id));
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    const g = result.ir.graph as { nodes: { id: string; type: string; name: string }[]; edges: unknown[] };

    const gatewayNodes = g.nodes.filter((n) => n.type === 'gateway');
    const serviceNodes = g.nodes.filter((n) => n.type === 'service');
    const workerNodes = g.nodes.filter((n) => n.type === 'worker');

    expect(gatewayNodes.length).toBe(1);
    expect(serviceNodes.length).toBeGreaterThanOrEqual(1);
    expect(workerNodes.length).toBe(1);
    expect(workerNodes[0]!.name).toBe('worker');
  });
});

// ---- D4. External service nodes per destination ----------------------------

describe('External service identification: distinct nodes per URL destination', () => {
  it('creates separate external service nodes for Stripe, reCAPTCHA, and a gRPC target', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "billing-api" }',
      'src/billing.ts': `
import axios from 'axios';
async function charge(amount: number) {
  return axios.post('https://api.stripe.com/v1/charges', { amount });
}
`,
      'src/auth.ts': `
async function verifyRecaptcha(token: string) {
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: process.env.RECAPTCHA_SECRET!, response: token }),
  });
  return res.json();
}
`,
      'src/notifications.ts': `
import { NotificationServiceClient } from './proto/generated.js';
const client = new NotificationServiceClient('notifications-svc:50051');
`,
      'src/app.ts': `
import express from 'express';
const app = express();
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.listen(3000);
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    const g = result.ir.graph as { nodes: { id: string; type: string; name: string }[]; edges: unknown[] };

    const extNodes = g.nodes.filter((n) => n.type === 'service' && n.name !== 'external-service');
    const nodeNames = extNodes.map((n) => n.name);

    // Should have stripe and google (recaptcha) as distinct external nodes
    expect(nodeNames.some((n) => n.includes('stripe'))).toBe(true);
    expect(nodeNames.some((n) => n.includes('google'))).toBe(true);
    // Each is a distinct node
    const stripeNodes = extNodes.filter((n) => n.name.includes('stripe'));
    const googleNodes = extNodes.filter((n) => n.name.includes('google'));
    expect(stripeNodes.length).toBe(1);
    expect(googleNodes.length).toBe(1);
  });
});

// ---- D5. Monolithic app — negative case (no forced decomposition) ----------

describe('Monolithic app: all routes in one file → single service node', () => {
  it('does not split a monolith into multiple services', async () => {
    const root = await makeTmp();
    await writeFiles(root, {
      'package.json': '{ "name": "monolith" }',
      'app.ts': `
import express from 'express';
import { Pool } from 'pg';
const app = express();
const db = new Pool({ connectionString: process.env.DATABASE_URL });
app.get('/users', async (_req, res) => res.json(await db.query('SELECT 1')));
app.post('/payments', async (_req, res) => res.json({ ok: true }));
app.get('/reports', async (_req, res) => res.json([]));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(3000);
`,
    });

    const result = await reconstructIrFromCodebase({ from: root, language: 'nodejs' });
    const g = result.ir.graph as { nodes: { id: string; type: string }[]; edges: { from: string; to: string }[] };

    const httpNodes = g.nodes.filter((n) => n.type === 'gateway' || n.type === 'service');
    // Only one HTTP service node — the monolith
    expect(httpNodes.length).toBe(1);
    expect(httpNodes[0]!.type).toBe('gateway');

    // DB node should still be present and connected
    const dbNode = g.nodes.find((n) => n.type === 'postgres');
    expect(dbNode).toBeDefined();
    expect(g.edges.some((e) => e.from === httpNodes[0]!.id && e.to === dbNode?.id)).toBe(true);
  });
});
