const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true, coerceTypes: true });
const app = express();
app.use(bodyParser.json());

// CORS tightened via ALLOWED_ORIGINS env (comma-separated); defaults to none
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({ origin: allowed.length ? allowed : false }));

// Runtime kit: request id + timing + basic error handler
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  const start = Date.now();
  res.setHeader('x-request-id', req.requestId);
  res.on('finish', () => {
    res.setHeader('x-duration-ms', Date.now() - start);
  });
  next();
});

// Helper functions for inner nodes
// Helper functions for inner nodes (support nodes)
function authenticateRequest(req) {
  // TODO: Implement authentication logic
  return { valid: true, user: null };
}

function validateSchema(payload) {
  // TODO: Implement schema validation
  return { valid: true, errors: [] };
}

function parsePayload(payload) {
  // TODO: Implement payload parsing
  return payload;
}

// Handlers
async function handler_signup(req, res) {
  // Handler for node signup
  // TODO: rate limit / quota hook here
  const config = {"url":"/signup","method":"POST"};
  const requestId = req.requestId || req.headers['x-request-id'] || uuidv4();
  const filters = req.query || {};
  const page = Number(filters.page || filters.offset || 1);
  const pageSize = Number(filters.pageSize || filters.limit || 20);
  const status = filters.status || undefined;
  const dateFrom = filters.from || filters.startDate || undefined;
  const dateTo = filters.to || filters.endDate || undefined;
  const timeoutMs = Number(2000);
  const retryPolicy = {"maxAttempts":2,"backoffMs":500};
  const maxAttempts = Number(retryPolicy.maxAttempts || 1);
  const backoffMs = Number(retryPolicy.backoffMs || 200);
  const operation = "read";
  const primaryKey = "id";
  const table = "records";
  const baseQuery = "";

  // Simulated downstream/data access using retry + timeout
  async function runOperation() {
    // In real code, call DB/repo with filters/pagination and timeout using baseQuery/table/engine
    if (operation === 'create') {
      const body = req.body || {};
      const id = body[primaryKey] || `new-${Date.now()}`;
      return { created: { ...body, [primaryKey]: id, createdAt: new Date().toISOString(), table, query: baseQuery } };
    }
    if (operation === 'update') {
      const body = req.body || {};
      const id = body[primaryKey] || filters[primaryKey];
      if (!id) throw Object.assign(new Error('missing primary key'), { statusCode: 400 });
      return { updated: { ...body, [primaryKey]: id, updatedAt: new Date().toISOString(), table, query: baseQuery } };
    }
    if (operation === 'delete') {
      const id = filters[primaryKey] || (req.body || {})[primaryKey];
      if (!id) throw Object.assign(new Error('missing primary key'), { statusCode: 400 });
      return { deleted: true, id, table, query: baseQuery };
    }
    // READ path with filters/pagination
    const sample = Array.from({ length: Math.min(pageSize, 5) }).map((_, i) => ({
      [primaryKey]: `ORD-${page}-${i+1}`,
      status: status || 'pending',
      total: 100 + i,
      createdAt: new Date().toISOString(),
      table,
      query: baseQuery || undefined,
    }));
    return sample;
  }

  let data;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), timeoutMs);
      data = await runOperation();
      clearTimeout(to);
      break;
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error('[handler:handler_signup] failed after retries', err);
        const sc = err?.statusCode || 500;
        return res.status(sc).json({ error: 'upstream_failed', message: err?.message, requestId });
      }
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  // Audit log (placeholder)
  console.log('[audit]', { requestId, route: '/signup', status: 'success', filters: { status, dateFrom, dateTo, page, pageSize } });
  return res.status(201).json({ status: 'ok', requestId, data });
}

// Routes
app.post('/signup', handler_signup);

// Health/ready
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/ready', (req, res) => res.json({ ok: true }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'internal_error', requestId: req.requestId });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Server listening on ${port}`));