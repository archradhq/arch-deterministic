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
