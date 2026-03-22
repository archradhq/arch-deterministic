// Deterministic Node Express exporter (skeleton)
// Exports a map of filename -> content for a generated Express app.
import { getEdgeConfig, generateRetryCode, generateCircuitBreakerCode, type EdgeConfig } from './edgeConfigCodeGenerator.js';

export default async function generateNodeExpressFiles(actualIR: any, opts: any = {}): Promise<Record<string,string>> {
  const files: Record<string,string> = {};
  const graph = (actualIR && actualIR.graph) ? actualIR.graph : (actualIR || {});
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  const handlers: string[] = [];
  const routes: string[] = [];
  const endpoints: Array<{ route: string; method: string; hasBody: boolean; success: number; responseSchema?: any; requestSchema?: any }> = [];
  const nonHttpNodes: Array<{ id: string; type: string; name: string; schema?: any; config?: any }> = [];
  
  // Track edge config utilities (retry, circuit breaker) to include once
  const edgeUtilityCode = new Set<string>();

  function safeId(id: any) { return String(id || '').replace(/[^A-Za-z0-9_\-]/g,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'node'; }
  function handlerName(n: any) { return `handler_${safeId(n && (n.id || n.name))}`.replace(/-/g,'_'); }

  /**
   * Generate code for inner nodes (support nodes) that are embedded within a key node
   */
  function generateInnerNodeCode(innerNodes: any[]): string[] {
    const code: string[] = [];
    
    for (const innerNode of innerNodes) {
      if (!innerNode || !innerNode.type) continue;
      
      const innerType = String(innerNode.type || innerNode.kind || '').toLowerCase();
      const innerId = safeId(innerNode.id || innerNode.name);
      const innerCfg: any = (innerNode && (innerNode as any).config) || {};
      
      // Generate code based on inner node type
      if (innerType === 'transform' && innerCfg.transform === 'authenticate') {
        code.push(`  // Inner node: Authentication (${innerId})`);
        code.push(`  const authResult = authenticateRequest(req);`);
        code.push(`  if (!authResult.valid) {`);
        code.push(`    return res.status(401).json({ error: 'Unauthorized' });`);
        code.push(`  }`);
        code.push('');
      } else if (innerType === 'transform' && innerCfg.transform === 'validate') {
        code.push(`  // Inner node: Validation (${innerId})`);
        code.push(`  const validationResult = validateSchema(req.body);`);
        code.push(`  if (!validationResult.valid) {`);
        code.push(`    return res.status(400).json({ error: 'Validation failed', details: validationResult.errors });`);
        code.push(`  }`);
        code.push('');
      } else if (innerType === 'transform' && innerCfg.transform === 'parse') {
        code.push(`  // Inner node: Parse (${innerId})`);
        code.push(`  const parsedData = parsePayload(req.body);`);
        code.push('');
      } else if (innerType === 'retry' || innerCfg.retryPolicy) {
        code.push(`  // Inner node: Retry Logic (${innerId})`);
        code.push(`  const maxAttempts = ${innerCfg.maxAttempts || innerCfg.max_attempts || 3};`);
        code.push(`  for (let attempt = 0; attempt < maxAttempts; attempt++) {`);
        code.push(`    try {`);
        code.push(`      // Retryable operation`);
        code.push(`      break;`);
        code.push(`    } catch (error) {`);
        code.push(`      if (attempt === maxAttempts - 1) throw error;`);
        code.push(`      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000)); // Exponential backoff`);
        code.push(`    }`);
        code.push(`  }`);
        code.push('');
      } else if (innerType === 'error-handler' || innerCfg.errorHandling) {
        code.push(`  // Inner node: Error Handling (${innerId})`);
        code.push(`  try {`);
        code.push(`    // Error-handled operation`);
        code.push(`  } catch (error) {`);
        code.push(`    console.error(\`Error in ${innerId}:\`, error);`);
        code.push(`    return res.status(500).json({ error: error.message });`);
        code.push(`  }`);
        code.push('');
      }
    }
    
    return code;
  }

  for (const n of nodes) {
    if (!n || !n.type) continue;
    if (n.type === 'http' || n.type === 'cloudFunction' || n.type === 'httpRequest') {
      const id = safeId(n.id || n.name);
      const method = (n.config && n.config.method) ? String(n.config.method).toLowerCase() : 'post';
      const route = (n.config && (n.config.route || n.config.url)) ? String(n.config.route || n.config.url) : `/${id}`;
      const cfg: any = { ...(n && (n as any).config), ...(n && (n as any).data?.config) };
      // Extract businessLogic for implementation guidance
      const businessLogic = cfg.businessLogic || (n as any)?.businessLogic || (n as any)?.description || null;
      const isAsync = cfg.async === true || cfg.asyncProcessing === true || cfg.accepted === true;
      const requestSchema = cfg.schema || cfg.fields;
      const responseSchema = cfg.responseSchema || cfg.response_schema || cfg.response;
      const successCode = method === 'post' ? (isAsync ? 202 : 201) : method === 'delete' ? 204 : 200;
      const h = handlerName(n);
      endpoints.push({ route, method, hasBody: method !== 'get', success: successCode, responseSchema, requestSchema });
      
      // Get inner nodes if they exist (support nodes embedded in this key node)
      const innerNodes = (n as any).innerNodes || [];
      
      // Get edge configurations for incoming edges to this node
      const nodeId = String(n.id || '');
      const incomingEdges = edges.filter((e: any) => {
        const targetId = String(e.to || e.target || '');
        return targetId === nodeId;
      });
      
      // Collect edge configs and apply them
      let edgeRetryConfig: EdgeConfig | null = null;
      let edgeCircuitBreakerConfig: EdgeConfig | null = null;
      let edgeTimeout: number | null = null;
      
      for (const edge of incomingEdges) {
        const sourceId = String(edge.from || edge.source || '');
        const edgeConfig = getEdgeConfig(edges, sourceId, nodeId);
        
        if (edgeConfig) {
          // Apply edge timeout (override node timeout if edge has one)
          if (edgeConfig.config?.timeout) {
            edgeTimeout = edgeConfig.config.timeout;
          }
          
          // Collect retry config from edge (prefer edge over node)
          if (edgeConfig.config?.retry?.maxAttempts && edgeConfig.config.retry.maxAttempts > 0) {
            edgeRetryConfig = edgeConfig;
            const retryCode = generateRetryCode(edgeConfig, 'nodejs');
            if (retryCode) {
              edgeUtilityCode.add(retryCode);
            }
          }
          
          // Collect circuit breaker config from edge
          if (edgeConfig.config?.circuitBreaker?.enabled) {
            edgeCircuitBreakerConfig = edgeConfig;
            const cbCode = generateCircuitBreakerCode(edgeConfig, 'nodejs');
            if (cbCode) {
              edgeUtilityCode.add(cbCode);
            }
          }
        }
      }
      
      // Build handler code with inner nodes
      const handlerLines: string[] = [];
      handlerLines.push(`async function ${h}(req, res) {`);
      // Include businessLogic in comment if available
      if (businessLogic) {
        handlerLines.push(`  // Business Logic: ${businessLogic}`);
      }
      handlerLines.push(`  // Handler for node ${String(n.id || '')}${innerNodes.length > 0 ? ` (with ${innerNodes.length} inner node(s))` : ''}`);
      
      // Add inner node code first (authentication, validation, etc.)
      if (innerNodes.length > 0) {
        const innerCode = generateInnerNodeCode(innerNodes);
        handlerLines.push(...innerCode);
      }
      
      // Validation with AJV if schema exists
      if (requestSchema && typeof requestSchema === 'object') {
        const schemaName = `${h}_schema`;
        handlerLines.unshift(`const ${schemaName} = ${JSON.stringify(requestSchema)};`);
        handlerLines.splice(
          handlerLines.findIndex((l) => l.startsWith('  // Add main business logic')),
          0,
          `  const validate = ajv.compile(${schemaName});`,
          `  const valid = validate(req.body || {});`,
          `  if (!valid) { return res.status(400).json({ error: 'validation_failed', details: validate.errors }); }`
        );
      }
      // Rate limit stub
      handlerLines.push(`  // TODO: rate limit / quota hook here`);
      // Add main business logic (use config to drive behavior)
      handlerLines.push(`  const config = ${JSON.stringify(cfg)};`);
      handlerLines.push(`  const requestId = req.requestId || req.headers['x-request-id'] || uuidv4();`);
      handlerLines.push(`  const filters = req.query || {};`);
      handlerLines.push(`  const page = Number(filters.page || filters.offset || 1);`);
      handlerLines.push(`  const pageSize = Number(filters.pageSize || filters.limit || 20);`);
      handlerLines.push(`  const status = filters.status || undefined;`);
      handlerLines.push(`  const dateFrom = filters.from || filters.startDate || undefined;`);
      handlerLines.push(`  const dateTo = filters.to || filters.endDate || undefined;`);
      // Use edge timeout if available, otherwise fall back to node config
      const effectiveTimeout = edgeTimeout ?? cfg.timeoutMs ?? 2000;
      handlerLines.push(`  const timeoutMs = Number(${effectiveTimeout});`);
      
      // Use edge retry config if available, otherwise fall back to node config
      const effectiveRetryPolicy = edgeRetryConfig?.config?.retry || cfg.retryPolicy || { maxAttempts: 2, backoffMs: 500 };
      handlerLines.push(`  const retryPolicy = ${JSON.stringify(effectiveRetryPolicy)};`);
      handlerLines.push(`  const maxAttempts = Number(retryPolicy.maxAttempts || 1);`);
      handlerLines.push(`  const backoffMs = Number(retryPolicy.backoffMs || 200);`);
      const retryStrategy = edgeRetryConfig?.config?.retry?.strategy || 'exponential';
      handlerLines.push(`  const operation = ${JSON.stringify(cfg.operation || 'read')};`);
      handlerLines.push(`  const primaryKey = ${JSON.stringify(cfg.primaryKey || 'id')};`);
      handlerLines.push(`  const table = ${JSON.stringify(cfg.table || 'records')};`);
      handlerLines.push(`  const baseQuery = ${JSON.stringify(cfg.query || '')};`);
      handlerLines.push(``);
      if (businessLogic) {
        handlerLines.push(`  // Business Logic: ${businessLogic}`);
      }
      handlerLines.push(`  // Simulated downstream/data access using retry + timeout`);
      handlerLines.push(`  async function runOperation() {`);
      handlerLines.push(`    // In real code, call DB/repo with filters/pagination and timeout using baseQuery/table/engine`);
      handlerLines.push(`    if (operation === 'create') {`);
      handlerLines.push(`      const body = req.body || {};`);
      handlerLines.push(`      const id = body[primaryKey] || \`new-\${Date.now()}\`;`);
      handlerLines.push(`      return { created: { ...body, [primaryKey]: id, createdAt: new Date().toISOString(), table, query: baseQuery } };`);
      handlerLines.push(`    }`);
      handlerLines.push(`    if (operation === 'update') {`);
      handlerLines.push(`      const body = req.body || {};`);
      handlerLines.push(`      const id = body[primaryKey] || filters[primaryKey];`);
      handlerLines.push(`      if (!id) throw Object.assign(new Error('missing primary key'), { statusCode: 400 });`);
      handlerLines.push(`      return { updated: { ...body, [primaryKey]: id, updatedAt: new Date().toISOString(), table, query: baseQuery } };`);
      handlerLines.push(`    }`);
      handlerLines.push(`    if (operation === 'delete') {`);
      handlerLines.push(`      const id = filters[primaryKey] || (req.body || {})[primaryKey];`);
      handlerLines.push(`      if (!id) throw Object.assign(new Error('missing primary key'), { statusCode: 400 });`);
      handlerLines.push(`      return { deleted: true, id, table, query: baseQuery };`);
      handlerLines.push(`    }`);
      handlerLines.push(`    // READ path with filters/pagination`);
      handlerLines.push(`    const sample = Array.from({ length: Math.min(pageSize, 5) }).map((_, i) => ({`);
      handlerLines.push(`      [primaryKey]: \`ORD-\${page}-\${i+1}\`,`);
      handlerLines.push(`      status: status || 'pending',`);
      handlerLines.push(`      total: 100 + i,`);
      handlerLines.push(`      createdAt: new Date().toISOString(),`);
      handlerLines.push(`      table,`);
      handlerLines.push(`      query: baseQuery || undefined,`);
      handlerLines.push(`    }));`);
      handlerLines.push(`    return sample;`);
      handlerLines.push(`  }`);
      handlerLines.push(``);
      handlerLines.push(`  let data;`);
      
      // Use circuit breaker if configured on edge
      if (edgeCircuitBreakerConfig) {
        handlerLines.push(`  // Circuit breaker protection (from edge config)`);
        handlerLines.push(`  const circuitBreaker = new CircuitBreaker(${edgeCircuitBreakerConfig.config?.circuitBreaker?.failureThreshold || 5}, ${edgeCircuitBreakerConfig.config?.circuitBreaker?.resetTimeoutMs || 60000});`);
        handlerLines.push(`  try {`);
        handlerLines.push(`    data = await circuitBreaker.call(async () => {`);
        handlerLines.push(`      const controller = new AbortController();`);
        handlerLines.push(`      const to = setTimeout(() => controller.abort(), timeoutMs);`);
        handlerLines.push(`      const result = await runOperation();`);
        handlerLines.push(`      clearTimeout(to);`);
        handlerLines.push(`      return result;`);
        handlerLines.push(`    });`);
        handlerLines.push(`  } catch (err) {`);
        handlerLines.push(`    console.error('[handler:${h}] circuit breaker open or operation failed', err);`);
        handlerLines.push(`    const sc = err?.statusCode || 500;`);
        handlerLines.push(`    return res.status(sc).json({ error: 'upstream_failed', message: err?.message, requestId });`);
        handlerLines.push(`  }`);
      } else {
        // Use retry logic (from edge or node config)
        const useEdgeRetry = edgeRetryConfig && retryStrategy === 'exponential';
        if (useEdgeRetry) {
          handlerLines.push(`  // Retry with exponential backoff (from edge config)`);
          handlerLines.push(`  try {`);
          handlerLines.push(`    data = await retryWithExponentialBackoff(async () => {`);
          handlerLines.push(`      const controller = new AbortController();`);
          handlerLines.push(`      const to = setTimeout(() => controller.abort(), timeoutMs);`);
          handlerLines.push(`      const result = await runOperation();`);
          handlerLines.push(`      clearTimeout(to);`);
          handlerLines.push(`      return result;`);
          handlerLines.push(`    }, maxAttempts, backoffMs);`);
          handlerLines.push(`  } catch (err) {`);
          handlerLines.push(`    console.error('[handler:${h}] failed after retries', err);`);
          handlerLines.push(`    const sc = err?.statusCode || 500;`);
          handlerLines.push(`    return res.status(sc).json({ error: 'upstream_failed', message: err?.message, requestId });`);
          handlerLines.push(`  }`);
        } else {
          // Fallback to standard retry loop
          handlerLines.push(`  for (let attempt = 1; attempt <= maxAttempts; attempt++) {`);
          handlerLines.push(`    try {`);
          handlerLines.push(`      const controller = new AbortController();`);
          handlerLines.push(`      const to = setTimeout(() => controller.abort(), timeoutMs);`);
          handlerLines.push(`      data = await runOperation();`);
          handlerLines.push(`      clearTimeout(to);`);
          handlerLines.push(`      break;`);
          handlerLines.push(`    } catch (err) {`);
          handlerLines.push(`      if (attempt === maxAttempts) {`);
          handlerLines.push(`        console.error('[handler:${h}] failed after retries', err);`);
          handlerLines.push(`        const sc = err?.statusCode || 500;`);
          handlerLines.push(`        return res.status(sc).json({ error: 'upstream_failed', message: err?.message, requestId });`);
          handlerLines.push(`      }`);
          handlerLines.push(`      await new Promise(r => setTimeout(r, backoffMs));`);
          handlerLines.push(`    }`);
          handlerLines.push(`  }`);
        }
      }
      handlerLines.push(``);
      handlerLines.push(`  // Audit log (placeholder)`);
      handlerLines.push(`  console.log('[audit]', { requestId, route: '${route}', status: 'success', filters: { status, dateFrom, dateTo, page, pageSize } });`);
      if (successCode === 204) {
        handlerLines.push(`  return res.status(204).end();`);
      } else {
        handlerLines.push(`  return res.status(${successCode}).json({ status: 'ok', requestId, data });`);
      }
      handlerLines.push(`}`);
      
      handlers.push(handlerLines.join('\n'));
      routes.push(`app.${method}('${route}', ${h});`);
    }
  }

  // Helper functions for inner nodes
  const helperFunctions: string[] = [];
  helperFunctions.push('// Helper functions for inner nodes (support nodes)');
  helperFunctions.push('function authenticateRequest(req) {');
  helperFunctions.push('  // TODO: Implement authentication logic');
  helperFunctions.push('  return { valid: true, user: null };');
  helperFunctions.push('}');
  helperFunctions.push('');
  helperFunctions.push('function validateSchema(payload) {');
  helperFunctions.push('  // TODO: Implement schema validation');
  helperFunctions.push('  return { valid: true, errors: [] };');
  helperFunctions.push('}');
  helperFunctions.push('');
  helperFunctions.push('function parsePayload(payload) {');
  helperFunctions.push('  // TODO: Implement payload parsing');
  helperFunctions.push('  return payload;');
  helperFunctions.push('}');
  helperFunctions.push('');
  
  // Add edge config utilities (retry, circuit breaker) if any were generated
  if (edgeUtilityCode.size > 0) {
    helperFunctions.push('// Edge configuration utilities (retry, circuit breaker)');
    edgeUtilityCode.forEach(code => helperFunctions.push(code));
  }

  files['app/index.js'] = [
    "const express = require('express');",
    "const bodyParser = require('body-parser');",
    "const cors = require('cors');",
    "const { v4: uuidv4 } = require('uuid');",
    "const Ajv = require('ajv');",
    "const ajv = new Ajv({ allErrors: true, coerceTypes: true });",
    "const app = express();",
    "app.use(bodyParser.json());",
    "",
    "// CORS tightened via ALLOWED_ORIGINS env (comma-separated); defaults to none",
    "const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);",
    "app.use(cors({ origin: allowed.length ? allowed : false }));",
    "",
    "// Runtime kit: request id + timing + basic error handler",
    "app.use((req, res, next) => {",
    "  req.requestId = req.headers['x-request-id'] || uuidv4();",
    "  const start = Date.now();",
    "  res.setHeader('x-request-id', req.requestId);",
    "  res.on('finish', () => {",
    "    res.setHeader('x-duration-ms', Date.now() - start);",
    "  });",
    "  next();",
    "});",
    "",
    "// Helper functions for inner nodes",
    helperFunctions.join('\n'),
    "// Handlers",
    handlers.join('\n\n'),
    "",
    "// Routes",
    routes.join('\n'),
    "",
    "// Health/ready",
    "app.get('/healthz', (req, res) => res.json({ ok: true }));",
    "app.get('/ready', (req, res) => res.json({ ok: true }));",
    "",
    "// Error handler",
    "app.use((err, req, res, next) => {",
    "  console.error('Unhandled error', err);",
    "  res.status(500).json({ error: 'internal_error', requestId: req.requestId });",
    "});",
    "",
    "const port = Number(process.env.PORT) || 8080;",
    "app.listen(port, '0.0.0.0', () => console.log(`Server listening on ${port}`));"
  ].join('\n');

  files['package.json'] = JSON.stringify({
    name: (opts.projectName || (actualIR && actualIR.metadata && actualIR.metadata.name) || 'generated-express'),
    version: '0.1.0',
    main: 'app/index.js',
    scripts: { start: 'node app/index.js' },
    dependencies: {
      express: '^4.18.0',
      'body-parser': '^1.20.0',
      uuid: '^9.0.1',
      cors: '^2.8.5',
      ajv: '^8.12.0',
    },
  }, null, 2);

  files['tests/contract.test.js'] = [
    "const fs = require('fs');",
    "const path = require('path');",
    "describe('contract', () => {",
    "  it('should have an openapi file', () => {",
    "    const spec = fs.readFileSync(path.join(__dirname, '../openapi.yaml'), 'utf-8');",
    "    expect(spec).toBeTruthy();",
    "  });",
    "});",
  ].join('\n');

  // Non-http nodes
  nodes.forEach((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const n = raw as Record<string, unknown>;
    if (!n.type) return;
    const t = String(n.type || '').toLowerCase();
    if (t.includes('http')) return;
    const cfg: Record<string, unknown> =
      n.config && typeof n.config === 'object' && !Array.isArray(n.config)
        ? (n.config as Record<string, unknown>)
        : {};
    nonHttpNodes.push({
      id: String(n.id || ''),
      type: String(n.type || ''),
      name: String(n.name || n.id || ''),
      schema: cfg.schema || cfg.fields,
      config: cfg,
    });
  });

  files['openapi.yaml'] = buildOpenApiSpec(
    opts.projectName || (actualIR && actualIR.metadata && actualIR.metadata.name) || 'generated-express',
    endpoints,
    nonHttpNodes
  );

  files['README.md'] = `# ${opts.projectName || 'generated-express'}\n\nGenerated Express app.\n\nRun:\n\n    npm install\n    npm start\n`;

  return files;
}

function renderSchema(schema: any, indent = '          '): string[] {
  if (!schema || typeof schema !== 'object') {
    return [`${indent}type: object`];
  }
  const lines: string[] = [];
  const t =
    schema.type ||
    schema.dataType ||
    (schema.properties ? 'object' : Array.isArray(schema) || schema.items ? 'array' : 'object');
  lines.push(`${indent}type: ${t === 'integer' ? 'number' : t}`);
  if (t === 'array' && schema.items) {
    lines.push(`${indent}items:`);
    lines.push(...renderSchema(schema.items, `${indent}  `));
  }
  if (t === 'object' && schema.properties && typeof schema.properties === 'object') {
    lines.push(`${indent}properties:`);
    Object.entries(schema.properties).forEach(([k, v]) => {
      lines.push(`${indent}  ${k}:`);
      lines.push(...renderSchema(v, `${indent}    `));
    });
  }
  if (schema.format) {
    lines.push(`${indent}format: ${schema.format}`);
  }
  return lines;
}

function buildOpenApiSpec(
  serviceName: string,
  endpoints: Array<{ route: string; method: string; hasBody: boolean; success: number; responseSchema?: any; requestSchema?: any }>,
  nonHttpNodes: Array<{ id: string; type: string; name: string; schema?: any; config?: any }>
): string {
  const schemaEntries: Array<{ name: string; schema: any }> = [];
  const seenSchemas = new Set<string>();
  const safeName = (route: string, method: string, kind: 'request' | 'response') =>
    `${method.toLowerCase()}_${route.replace(/[^A-Za-z0-9]+/g, '_') || 'root'}_${kind}`;
  const addSchema = (name: string, schema: any) => {
    const key = JSON.stringify(schema || {});
    if (!schema || typeof schema !== 'object') return null;
    const compositeKey = `${name}:${key}`;
    if (seenSchemas.has(compositeKey)) return name;
    seenSchemas.add(compositeKey);
    schemaEntries.push({ name, schema });
    return name;
  };
  const lines: string[] = [];
  lines.push('openapi: 3.0.0');
  lines.push('info:');
  lines.push(`  title: ${serviceName}`);
  lines.push('  version: 0.0.1');
  lines.push('paths:');
  if (!endpoints.length) {
    lines.push('  /:');
    lines.push('    get:');
    lines.push('      responses:');
    lines.push('        "200":');
    lines.push('          description: OK');
  } else {
    endpoints.forEach((ep) => {
      const lower = ep.method.toLowerCase();
      const success = String(ep.success || 200);
      lines.push(`  ${ep.route}:`);
      lines.push(`    ${lower}:`);
      const reqRef = ep.requestSchema ? addSchema(safeName(ep.route, ep.method, 'request'), ep.requestSchema) : null;
      const resRef = ep.responseSchema ? addSchema(safeName(ep.route, ep.method, 'response'), ep.responseSchema) : null;
      if (ep.hasBody && success !== '204') {
        lines.push('      requestBody:');
        lines.push('        content:');
        lines.push('          application/json:');
        lines.push('            schema:');
        if (reqRef) {
          lines.push(`              $ref: "#/components/schemas/${reqRef}"`);
        } else {
          lines.push(...renderSchema(ep.requestSchema || {}, '              '));
        }
      }
      lines.push('      responses:');
      lines.push(`        "${success}":`);
      lines.push(
        `          description: ${success === '201' ? 'Created' : success === '202' ? 'Accepted' : success === '204' ? 'No Content' : 'OK'}`
      );
      if (success !== '204') {
        lines.push('          content:');
        lines.push('            application/json:');
        lines.push('              schema:');
        if (resRef) {
          lines.push(`                $ref: "#/components/schemas/${resRef}"`);
        } else if (ep.responseSchema) {
          lines.push(...renderSchema(ep.responseSchema, '                '));
        } else {
          lines.push('                $ref: "#/components/schemas/Response"');
        }
      }
      lines.push('        "400":');
      lines.push('          description: Bad Request');
      lines.push('        "401":');
      lines.push('          description: Unauthorized');
      lines.push('        "500":');
      lines.push('          description: Server Error');
    });
  }
  lines.push('components:');
  lines.push('  schemas:');
  lines.push('    Response:');
  lines.push('      type: object');
  lines.push('      properties:');
  lines.push('        status:');
  lines.push('          type: string');
  lines.push('        message:');
  lines.push('          type: string');
  lines.push('        data:');
  lines.push('          type: object');
  schemaEntries.forEach((entry) => {
    lines.push(`    ${entry.name}:`);
    lines.push(...renderSchema(entry.schema, '      '));
  });
  if (nonHttpNodes && nonHttpNodes.length) {
    lines.push('x-nonHttpNodes:');
    nonHttpNodes.forEach((n) => {
      const componentName = addSchema(`nonhttp_${n.type}_${n.id}`, n.schema || {});
      lines.push(`  - id: ${n.id}`);
      lines.push(`    type: ${n.type}`);
      lines.push(`    name: ${JSON.stringify(n.name)}`);
      if (n.config && Object.keys(n.config).length) {
        lines.push('    configKeys:');
        Object.keys(n.config).slice(0, 8).forEach((k) => lines.push(`      - ${k}`));
      }
      if (componentName) {
        lines.push(`    schemaRef: "#/components/schemas/${componentName}"`);
      }
    });
  }
  return lines.join('\n');
}
