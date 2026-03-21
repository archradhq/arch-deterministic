// Deterministic Python FastAPI exporter
// Produces a map of filename -> content given an IR (plan graph) and options.
import { getEdgeConfig, generateRetryCode, generateCircuitBreakerCode, type EdgeConfig } from './edgeConfigCodeGenerator.js';

function safeId(id: any) {
  return String(id || '').replace(/[^A-Za-z0-9_\-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'node';
}

function handlerNameFor(n: any) {
  if (n && n.config && n.config.name) return String(n.config.name).replace(/[^A-Za-z0-9_]/g, '_');
  const id = safeId(n && n.id ? n.id : n && n.name ? n.name : 'handler');
  return `handler_${id.replace(/-/g,'_')}`;
}

function pyTypeFromSchema(def: any): string {
  const dtype = def?.type || def?.dataType || (def?.properties ? 'object' : def?.items ? 'array' : 'string');
  if (dtype === 'number' || dtype === 'integer') return 'float';
  if (dtype === 'boolean') return 'bool';
  if (dtype === 'array') return 'List[Any]';
  if (dtype === 'object') return 'Dict[str, Any]';
  return 'str';
}

function buildPydanticModel(className: string, schema: any): string {
  if (!schema || typeof schema !== 'object') {
    return `class ${className}(BaseModel):\n    status: str = "ok"\n    message: str | None = None\n    data: Dict[str, Any] | None = None\n`;
  }
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : schema;
  const lines: string[] = [`class ${className}(BaseModel):`];
  lines.push('    status: str = "ok"');
  lines.push('    message: str | None = None');
  lines.push('    data: Dict[str, Any] | None = None');
  if (props && typeof props === 'object') {
    const keys = Object.keys(props);
    keys.forEach((k) => {
      const ident = k.replace(/[^A-Za-z0-9_]/g, '_') || 'field';
      const t = pyTypeFromSchema((props as any)[k]);
      lines.push(`    ${ident}: ${t} | None = None`);
    });
  }
  lines.push('');
  return lines.join('\n');
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
      code.push(`    # Inner node: Authentication (${innerId})`);
      code.push(`    auth_result = authenticate_request(request)`);
      code.push(`    if not auth_result.get('valid', False):`);
      code.push(`        return {"error": "Unauthorized", "status": 401}`);
      code.push('');
    } else if (innerType === 'transform' && innerCfg.transform === 'validate') {
      code.push(`    # Inner node: Validation (${innerId})`);
      code.push(`    validation_result = validate_schema(payload)`);
      code.push(`    if not validation_result.get('valid', False):`);
      code.push(`        return {"error": "Validation failed", "status": 400, "details": validation_result.get('errors', [])}`);
      code.push('');
    } else if (innerType === 'transform' && innerCfg.transform === 'parse') {
      code.push(`    # Inner node: Parse (${innerId})`);
      code.push(`    parsed_data = parse_payload(payload)`);
      code.push('');
    } else if (innerType === 'retry' || innerCfg.retryPolicy) {
      code.push(`    # Inner node: Retry Logic (${innerId})`);
      code.push(`    max_attempts = ${innerCfg.maxAttempts || innerCfg.max_attempts || 3}`);
      code.push(`    for attempt in range(max_attempts):`);
      code.push(`        try:`);
      code.push(`            # Retryable operation`);
      code.push(`            break`);
      code.push(`        except Exception as e:`);
      code.push(`            if attempt == max_attempts - 1:`);
      code.push(`                raise`);
      code.push(`            await asyncio.sleep(2 ** attempt)  # Exponential backoff`);
      code.push('');
    } else if (innerType === 'error-handler' || innerCfg.errorHandling) {
      code.push(`    # Inner node: Error Handling (${innerId})`);
      code.push(`    try:`);
      code.push(`        # Error-handled operation`);
      code.push(`        pass`);
      code.push(`    except Exception as e:`);
      code.push(`        logger.error(f"Error in ${innerId}: {str(e)}")`);
      code.push(`        return {"error": str(e), "status": 500}`);
      code.push('');
    }
  }
  
  return code;
}

export default async function generatePythonFastAPIFiles(actualIR: any, opts: any = {}): Promise<Record<string,string>> {
  const files: Record<string,string> = {};
  const graph: { nodes?: any[]; edges?: any[]; metadata?: any } =
    actualIR && actualIR.graph ? actualIR.graph : actualIR || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  const handlers: string[] = [];
  const routes: string[] = [];
  const models: string[] = [];
  const endpoints: Array<{ route: string; method: string; hasBody: boolean; success: number; responseSchema?: any; requestSchema?: any }> = [];
  const nonHttpNodes: Array<{ id: string; type: string; name: string; schema?: any; config?: any }> = [];
  
  // Track edge config utilities (retry, circuit breaker) to include once
  const edgeUtilityCode = new Set<string>();

  for (const n of nodes) {
    // expose cloudFunction and http nodes as FastAPI endpoints
    if (!n || !n.type) continue;
    if (n.type === 'cloudFunction' || n.type === 'http' || n.type === 'httpRequest') {
      const id = safeId(n.id || n.name);
      const nodeConfig = (n as any)?.config || {};
      const dataConfig = (n as any)?.data?.config || {};
      const cfg: any = { ...nodeConfig, ...dataConfig };
      // Extract businessLogic for implementation guidance
      const businessLogic = cfg.businessLogic || (n as any)?.businessLogic || (n as any)?.description || null;
      const method = String(cfg.method || 'post').toLowerCase();
      const route = cfg.route || cfg.url ? String(cfg.route || cfg.url) : `/${id}`;
      const isAsync = cfg.async === true || cfg.asyncProcessing === true || cfg.accepted === true;
      const successCode =
        method === 'post' ? (isAsync ? 202 : 201) : method === 'delete' ? 204 : 200;
      const hname = handlerNameFor(n);
      const reqModelName = `Payload${id.replace(/[^A-Za-z0-9]/g, '') || 'Request'}`;
      const respModelName = `Response${id.replace(/[^A-Za-z0-9]/g, '') || 'Response'}`;
      const requestSchema = cfg.schema || cfg.fields;
      const responseSchema = cfg.responseSchema || cfg.response_schema || cfg.response;
      models.push(buildPydanticModel(reqModelName, requestSchema));
      models.push(buildPydanticModel(respModelName, responseSchema));
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
            const retryCode = generateRetryCode(edgeConfig, 'python');
            if (retryCode) {
              edgeUtilityCode.add(retryCode);
            }
          }
          
          // Collect circuit breaker config from edge
          if (edgeConfig.config?.circuitBreaker?.enabled) {
            edgeCircuitBreakerConfig = edgeConfig;
            const cbCode = generateCircuitBreakerCode(edgeConfig, 'python');
            if (cbCode) {
              edgeUtilityCode.add(cbCode);
            }
          }
        }
      }
      
      // Build handler code with inner nodes
      const handlerLines: string[] = [];
      handlerLines.push(`def ${hname}(payload: ${reqModelName} | None = None):`);
      // Include businessLogic in docstring if available
      const docstring = businessLogic 
        ? `    """Handler for node ${String(n.id || '')}${innerNodes.length > 0 ? ` (with ${innerNodes.length} inner node(s))` : ''}\n    \n    Business Logic: ${businessLogic}\n    """`
        : `    """Handler for node ${String(n.id || '')}${innerNodes.length > 0 ? ` (with ${innerNodes.length} inner node(s))` : ''}"""`;
      handlerLines.push(docstring);
      if (businessLogic) {
        handlerLines.push(`    # Business Logic: ${businessLogic}`);
      }
      handlerLines.push('    # Rate limit / quota stub');
      handlerLines.push('    # TODO: implement per-endpoint rate limiting');
      handlerLines.push('    # Policy enforcement (fail open on error)');
      handlerLines.push('    import asyncio');
      handlerLines.push('    try:');
      handlerLines.push('        ok = asyncio.get_event_loop().run_until_complete(enforce_policy({"nodeId": "' + String(n.id || '') + '", "route": "' + route + '", "method": "' + method + '"}))');
      handlerLines.push('        if not ok:');
      handlerLines.push('            return Response(status_code=403, content="policy_blocked")');
      handlerLines.push('    except Exception:');
      handlerLines.push('        logging.warning("Policy check failed; continuing");');
      
      // Add inner node code first (authentication, validation, etc.)
      if (innerNodes.length > 0) {
        const innerCode = generateInnerNodeCode(innerNodes);
        handlerLines.push(...innerCode);
      }
      
      // Add main business logic driven by config
      handlerLines.push('    import asyncio');
      handlerLines.push('    import time');
      handlerLines.push(`    config = ${JSON.stringify(cfg)}`);
      handlerLines.push('    request_id = str(getattr(payload, "requestId", None) or "")');
      handlerLines.push('    filters = getattr(payload, "filters", {}) if payload else {}');
      handlerLines.push('    page = int(filters.get("page", filters.get("offset", 1)) or 1)');
      handlerLines.push('    page_size = int(filters.get("pageSize", filters.get("limit", 20)) or 20)');
      handlerLines.push('    status = filters.get("status")');
      handlerLines.push('    date_from = filters.get("from") or filters.get("startDate")');
      handlerLines.push('    date_to = filters.get("to") or filters.get("endDate")');
      // Use edge timeout if available, otherwise fall back to node config
      const effectiveTimeout = edgeTimeout ?? cfg.timeoutMs ?? 2000;
      handlerLines.push(`    timeout_ms = int(${effectiveTimeout})`);
      
      // Use edge retry config if available, otherwise fall back to node config
      const effectiveRetryPolicy = edgeRetryConfig?.config?.retry || cfg.retryPolicy || { "maxAttempts": 2, "backoffMs": 500 };
      handlerLines.push(`    retry_policy = ${JSON.stringify(effectiveRetryPolicy)}`);
      handlerLines.push('    max_attempts = int(retry_policy.get("maxAttempts", 1))');
      handlerLines.push('    backoff_ms = int(retry_policy.get("backoffMs", 200))');
      const retryStrategy = edgeRetryConfig?.config?.retry?.strategy || 'exponential';
    handlerLines.push(`    operation = ${JSON.stringify(cfg.operation || 'read')}`);
    handlerLines.push(`    primary_key = ${JSON.stringify(cfg.primaryKey || 'id')}`);
    handlerLines.push(`    table = ${JSON.stringify(cfg.table || 'records')}`);
    handlerLines.push(`    base_query = ${JSON.stringify(cfg.query || '')}`);
      handlerLines.push('');
    handlerLines.push('    async def run_operation():');
    // Use businessLogic to generate more specific implementation
    if (businessLogic) {
      handlerLines.push(`        # Business Logic: ${businessLogic}`);
      // Generate implementation based on businessLogic keywords
      if (businessLogic.toLowerCase().includes('validate') || businessLogic.toLowerCase().includes('check')) {
        handlerLines.push('        # Validation logic based on business requirements');
        handlerLines.push('        if payload:');
        handlerLines.push('            payload_dict = payload.dict() if hasattr(payload, "dict") else payload');
        handlerLines.push('            # Add validation checks based on business rules');
      }
      if (businessLogic.toLowerCase().includes('fetch') || businessLogic.toLowerCase().includes('get') || businessLogic.toLowerCase().includes('retrieve')) {
        handlerLines.push('        # Fetch/retrieve operation based on business logic');
      }
      if (businessLogic.toLowerCase().includes('create') || businessLogic.toLowerCase().includes('insert')) {
        handlerLines.push('        # Create operation with business validation');
      }
      if (businessLogic.toLowerCase().includes('calculate') || businessLogic.toLowerCase().includes('compute')) {
        handlerLines.push('        # Calculation logic based on business rules');
      }
    }
    handlerLines.push('        # Database operation honoring config/query/engine');
    handlerLines.push('        if operation == "create":');
    handlerLines.push('            body = payload.dict() if payload else {};');
    handlerLines.push('            new_id = body.get(primary_key) or f"new-{int(time.time()*1000)}"');
    handlerLines.push('            created = {**body, primary_key: new_id, "createdAt": datetime.utcnow().isoformat() + "Z", "table": table, "query": base_query}');
    handlerLines.push('            return {"created": created}');
    handlerLines.push('        if operation == "update":');
    handlerLines.push('            body = payload.dict() if payload else {};');
    handlerLines.push('            the_id = body.get(primary_key) or filters.get(primary_key)');
    handlerLines.push('            if not the_id:');
    handlerLines.push('                raise HTTPException(status_code=400, detail="missing primary key")');
    handlerLines.push('            updated = {**body, primary_key: the_id, "updatedAt": datetime.utcnow().isoformat() + "Z", "table": table, "query": base_query}');
    handlerLines.push('            return {"updated": updated}');
    handlerLines.push('        if operation == "delete":');
    handlerLines.push('            the_id = filters.get(primary_key) or ((payload.dict() if payload else {}).get(primary_key) if payload else None)');
    handlerLines.push('            if not the_id:');
    handlerLines.push('                raise HTTPException(status_code=400, detail="missing primary key")');
    handlerLines.push('            return {"deleted": True, "id": the_id, "table": table, "query": base_query}');
    handlerLines.push('        rows = [');
    handlerLines.push('            {');
    handlerLines.push('                primary_key: f"ORD-{page}-{i+1}",');
    handlerLines.push('                "status": status or "pending",');
    handlerLines.push('                "total": 100 + i,');
    handlerLines.push('                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),');
    handlerLines.push('                "table": table,');
    handlerLines.push('                "query": base_query or None');
    handlerLines.push('            } for i in range(min(page_size, 5))');
    handlerLines.push('        ]');
    handlerLines.push('        return rows');
      handlerLines.push('');
      handlerLines.push('    data = None');
      
      // Use circuit breaker if configured on edge
      if (edgeCircuitBreakerConfig) {
        handlerLines.push('    # Circuit breaker protection (from edge config)');
        handlerLines.push(`    circuit_breaker = CircuitBreaker(${edgeCircuitBreakerConfig.config?.circuitBreaker?.failureThreshold || 5}, ${(edgeCircuitBreakerConfig.config?.circuitBreaker?.resetTimeoutMs || 60000) / 1000})`);
        handlerLines.push('    try:');
        handlerLines.push('        # Wrap async operation for circuit breaker');
        handlerLines.push('        async def protected_operation():');
        handlerLines.push('            return await asyncio.wait_for(run_operation(), timeout_ms / 1000)');
        handlerLines.push('        # Circuit breaker expects sync function, so we run async in executor');
        handlerLines.push('        loop = asyncio.get_event_loop()');
        handlerLines.push('        data = await loop.run_in_executor(None, lambda: circuit_breaker.call(lambda: loop.run_until_complete(protected_operation())))');
        handlerLines.push('    except Exception as err:');
        handlerLines.push('        logger.error("circuit breaker open or operation failed", exc_info=True)');
        handlerLines.push('        return Response(status_code=500, content="upstream_failed")');
      } else {
        // Use retry logic (from edge or node config)
        const useEdgeRetry = edgeRetryConfig && retryStrategy === 'exponential';
        if (useEdgeRetry) {
          handlerLines.push('    # Retry with exponential backoff (from edge config)');
          handlerLines.push('    # Note: Edge retry utility is sync, so we adapt for async');
          handlerLines.push('    for attempt in range(max_attempts):');
          handlerLines.push('        try:');
          handlerLines.push('            data = await asyncio.wait_for(run_operation(), timeout_ms / 1000)');
          handlerLines.push('            break');
          handlerLines.push('        except Exception as err:');
          handlerLines.push('            if attempt == max_attempts - 1:');
          handlerLines.push('                logger.error("upstream_failed", exc_info=True)');
          handlerLines.push('                return Response(status_code=500, content="upstream_failed")');
          handlerLines.push('            # Exponential backoff: base_delay * (2 ** attempt)');
          handlerLines.push('            delay = (backoff_ms / 1000) * (2 ** attempt)');
          handlerLines.push('            await asyncio.sleep(delay)');
        } else {
          // Fallback to standard retry loop
          handlerLines.push('    for attempt in range(1, max_attempts + 1):');
          handlerLines.push('        try:');
          handlerLines.push('            # In real code, apply timeout using asyncio.wait_for');
          handlerLines.push('            data = await asyncio.wait_for(run_operation(), timeout_ms / 1000);');
          handlerLines.push('            break');
          handlerLines.push('        except Exception as err:');
          handlerLines.push('            if attempt == max_attempts:');
          handlerLines.push('                logger.error("upstream_failed", exc_info=True)');
          handlerLines.push('                return Response(status_code=500, content="upstream_failed")');
          handlerLines.push('            await asyncio.sleep(backoff_ms / 1000)');
        }
      }
      handlerLines.push('');
      handlerLines.push('    logger.info({');
      handlerLines.push('        "event": "audit",');
      handlerLines.push('        "route": "' + route + '",');
      handlerLines.push('        "status": "success",');
      handlerLines.push('        "filters": {');
      handlerLines.push('            "status": status, "date_from": date_from, "date_to": date_to, "page": page, "page_size": page_size');
      handlerLines.push('        }');
      handlerLines.push('    })');
      if (successCode === 204) {
        handlerLines.push('    return Response(status_code=204)');
      } else {
        handlerLines.push(
          `    return ${respModelName}(status="ok", message="Handled ${String(
            n.name || n.id || ''
          )}", data={"items": data, "page": page, "pageSize": page_size})`
        );
      }
      handlerLines.push('');
      
      handlers.push(handlerLines.join('\n'));

      // route wrapper
      const routeLines: string[] = [];
      const statusCode = successCode;
      const responseModelPart = statusCode === 204 ? 'response_model=None' : `response_model=${respModelName}`;
      const methodDecorator =
        method === 'get'
          ? `@app.get("${route}", ${responseModelPart}, status_code=${statusCode})`
          : `@app.post("${route}", ${responseModelPart}, status_code=${statusCode})`;
      routeLines.push(methodDecorator);
      routeLines.push(`async def ${hname}_endpoint(request):`);
      routeLines.push('    try:');
      routeLines.push('        payload_dict = await request.json()');
      routeLines.push('    except Exception:');
      routeLines.push('        payload_dict = {}');
      routeLines.push(`    payload = ${reqModelName}(**payload_dict) if payload_dict else None`);
      routeLines.push(`    return ${hname}(payload)`);
      routeLines.push('');
      routes.push(routeLines.join('\n'));
    }
  }
  // Collect non-http nodes
  nodes.forEach((n) => {
    if (!n || !n.type) return;
    const t = String(n.type || '').toLowerCase();
    if (t.includes('http')) return;
    const cfg = (n as any).config || (n as any).data?.config || {};
    nonHttpNodes.push({
      id: String(n.id || ''),
      type: String(n.type || ''),
      name: String(n.name || n.id || ''),
      schema: cfg.schema || cfg.fields,
      config: cfg,
    });
  });

  // Helper functions for inner nodes
  const helperFunctions: string[] = [];
  helperFunctions.push('# Helper functions for inner nodes (support nodes)');
  helperFunctions.push('import asyncio');
  helperFunctions.push('import logging');
  helperFunctions.push('');
  helperFunctions.push('logger = logging.getLogger(__name__)');
  helperFunctions.push('');
  helperFunctions.push('def authenticate_request(request):');
  helperFunctions.push('    """Authentication helper for inner nodes"""');
  helperFunctions.push('    # Implement authentication based on request headers');
  helperFunctions.push('    auth_header = request.headers.get("Authorization", "") if hasattr(request, "headers") else ""');
  helperFunctions.push('    if auth_header.startswith("Bearer "):');
  helperFunctions.push('        token = auth_header[7:]');
  helperFunctions.push('        # Validate JWT token (implement actual validation)');
  helperFunctions.push('        # For now, return valid if token exists');
  helperFunctions.push('        return {"valid": bool(token), "user": {"id": "user-123", "token": token[:10] + "..."} if token else None}');
  helperFunctions.push('    return {"valid": False, "user": None, "error": "Missing or invalid authorization"}');
  helperFunctions.push('');
  helperFunctions.push('def validate_schema(payload: dict):');
  helperFunctions.push('    """Schema validation helper for inner nodes"""');
  helperFunctions.push('    # Implement schema validation based on payload structure');
  helperFunctions.push('    errors = []');
  helperFunctions.push('    if not payload:');
  helperFunctions.push('        return {"valid": False, "errors": ["Payload is required"]}');
  helperFunctions.push('    # Add field-specific validation based on schema');
  helperFunctions.push('    # Example: check required fields, types, ranges, etc.');
  helperFunctions.push('    return {"valid": len(errors) == 0, "errors": errors}');
  helperFunctions.push('');
  helperFunctions.push('def parse_payload(payload: dict):');
  helperFunctions.push('    """Payload parsing helper for inner nodes"""');
  helperFunctions.push('    # Parse and normalize payload data');
  helperFunctions.push('    if isinstance(payload, str):');
  helperFunctions.push('        import json');
  helperFunctions.push('        try:');
  helperFunctions.push('            return json.loads(payload)');
  helperFunctions.push('        except json.JSONDecodeError:');
  helperFunctions.push('            return {"error": "Invalid JSON", "raw": payload}');
  helperFunctions.push('    # Normalize dict keys, handle nested structures');
  helperFunctions.push('    if isinstance(payload, dict):');
  helperFunctions.push('        return {k: v for k, v in payload.items() if v is not None}');
  helperFunctions.push('    return payload');
  helperFunctions.push('');
  
  // Add edge config utilities (retry, circuit breaker) if any were generated
  if (edgeUtilityCode.size > 0) {
    helperFunctions.push('# Edge configuration utilities (retry, circuit breaker)');
    edgeUtilityCode.forEach(code => helperFunctions.push(code));
  }

  // main app file
  const appLines: string[] = [];
  appLines.push('from fastapi import FastAPI, Request, Response');
  appLines.push('from typing import Dict, Any, List');
  appLines.push('from pydantic import BaseModel');
  appLines.push('import time');
  appLines.push('import uuid');
  appLines.push('import logging');
  appLines.push('import httpx');
  appLines.push('from fastapi.middleware.cors import CORSMiddleware');
  appLines.push('');
  appLines.push("app = FastAPI(title=\"Generated FastAPI App\")");
  appLines.push('');
  appLines.push("# CORS tightened via ALLOWED_ORIGINS env; defaults to none");
  appLines.push("import os");
  appLines.push("allowed = [o for o in os.getenv('ALLOWED_ORIGINS', '').split(',') if o]");
  appLines.push("if allowed:");
  appLines.push("    app.add_middleware(CORSMiddleware, allow_origins=allowed, allow_credentials=True, allow_methods=['*'], allow_headers=['*'])");
  appLines.push('');
  appLines.push('# Middlewares');
  appLines.push('@app.middleware("http")');
  appLines.push('async def runtime_middleware(request: Request, call_next):');
  appLines.push('    rid = request.headers.get("x-request-id", str(uuid.uuid4()))');
  appLines.push('    start = time.time()');
  appLines.push('    request.state.request_id = rid');
  appLines.push('    try:');
  appLines.push('        response = await call_next(request)');
  appLines.push('    except Exception as exc:');
  appLines.push('        logging.exception("Request failed");');
  appLines.push('        return Response(status_code=500, content="internal error")');
  appLines.push('    duration = int((time.time() - start) * 1000)');
  appLines.push('    response.headers["x-request-id"] = rid');
  appLines.push('    response.headers["x-duration-ms"] = str(duration)');
  appLines.push('    return response');
  appLines.push('');
  appLines.push('async def enforce_policy(payload: dict) -> bool:');
  appLines.push('    url = ""');
  appLines.push('    api_key = ""');
  appLines.push('    if not url:');
  appLines.push('        return True');
  appLines.push('    try:');
  appLines.push('        async with httpx.AsyncClient() as client:');
  appLines.push('            headers = {"x-api-key": api_key} if api_key else {}');
  appLines.push('            resp = await client.post(url, json=payload, headers=headers)');
  appLines.push('            return resp.status_code < 300');
  appLines.push('    except Exception:');
  appLines.push('        logging.warning("Policy enforcement failed", exc_info=True)');
  appLines.push('        return True  # fail open');
  appLines.push('');
  // models
  appLines.push('# Models derived from node schemas');
  appLines.push(models.join('\n'));
  // include helper functions
  appLines.push(helperFunctions.join('\n'));
  // include handlers
  appLines.push('# Handlers');
  appLines.push(handlers.join('\n'));
  appLines.push('');
  appLines.push('# Routes');
  appLines.push(routes.join('\n'));
  appLines.push('');
  appLines.push('@app.get("/healthz")');
  appLines.push('async def healthz():');
  appLines.push('    return {"ok": True}');
  appLines.push('');
  appLines.push('@app.get("/ready")');
  appLines.push('async def ready():');
  appLines.push('    return {"ok": True}');
  appLines.push('');
  appLines.push("if __name__ == '__main__':");
  appLines.push("    import uvicorn");
  appLines.push("    uvicorn.run(app, host='0.0.0.0', port=8080)");

  files['app/main.py'] = appLines.join('\n');

  // requirements
  files['requirements.txt'] = 'fastapi\nuvicorn\nhttpx\npydantic\n';

  // pyproject.toml — single project root (like .sln for C#, package.json for Node)
  const projectName = String((opts && opts.projectName) || (actualIR && actualIR.metadata && actualIR.metadata.name) || 'generated-fastapi').replace(/[^A-Za-z0-9_-]/g, '-');
  files['pyproject.toml'] = `[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "${projectName}"
version = "0.1.0"
description = "Generated FastAPI project"
requires-python = ">=3.10"
dependencies = [
  "fastapi>=0.104.0",
  "uvicorn>=0.24.0",
  "httpx>=0.25.0",
  "pydantic>=2.0.0",
]
`;

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

  files['openapi.yaml'] = buildOpenApiSpec(opts.projectName || (actualIR && actualIR.metadata && actualIR.metadata.name) || 'generated-fastapi', endpoints, nonHttpNodes);

  // README
  const projectDisplayName = String((opts && opts.projectName) || (actualIR && actualIR.metadata && actualIR.metadata.name) || 'generated-fastapi');
  files['README.md'] = `# ${projectDisplayName}\n\nGenerated FastAPI project.\n\nRun:\n\n    pip install -r requirements.txt\n    python app/main.py\n`;

  return files;
}
