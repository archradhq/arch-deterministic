#!/usr/bin/env node
/**
 * generate-corpus.mjs
 *
 * • Default (no --count / --generate): validate hand-written corpus/*.json
 * • Generate: synthetic IR graphs → ArchRad engine → JSONL training pairs
 *
 * Usage:
 *   npm run build
 *   npm run generate-corpus
 *   node scripts/generate-corpus.mjs --count 1000 --out corpus/auto-generated.jsonl
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIrGraph, validateIrLint, validateIrStructural } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const corpusDir = join(ROOT, 'corpus');

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const wantsGenerate = argv.includes('--generate') || argv.includes('--count');

const getArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

// ─── Validate hand-written corpus (default) ───────────────────────────────────

function isPairRecord(x) {
  return (
    x != null &&
    typeof x === 'object' &&
    typeof x.id === 'string' &&
    'input' in x &&
    'output' in x
  );
}

async function validateHandwritten() {
  let names;
  try {
    names = await readdir(corpusDir);
  } catch (e) {
    console.error('generate-corpus: cannot read corpus dir:', corpusDir, e);
    process.exitCode = 1;
    return;
  }

  const jsonFiles = names.filter((n) => n.endsWith('.json') && !n.startsWith('auto-')).sort();
  if (!jsonFiles.length) {
    console.error('generate-corpus: no hand-written .json files in', corpusDir);
    process.exitCode = 1;
    return;
  }

  let totalPairs = 0;
  for (const name of jsonFiles) {
    const path = join(corpusDir, name);
    let data;
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      console.error(`generate-corpus: ${path}:`, e);
      process.exitCode = 1;
      return;
    }
    if (!Array.isArray(data)) {
      console.error(`generate-corpus: ${name} must be a JSON array`);
      process.exitCode = 1;
      return;
    }
    for (let i = 0; i < data.length; i++) {
      if (!isPairRecord(data[i])) {
        console.error(`generate-corpus: ${name}[${i}] missing id/input/output`);
        process.exitCode = 1;
        return;
      }
    }
    totalPairs += data.length;
    console.log(`${name}: ${data.length} pair(s)`);
  }
  console.log(`generate-corpus: OK — ${jsonFiles.length} file(s), ${totalPairs} pair(s) total`);
}

// ─── Name pools (generation) ──────────────────────────────────────────────────

const GATEWAY_NAMES = [
  ['api-gateway', 'API Gateway'],
  ['web-gateway', 'Web Gateway'],
  ['mobile-gateway', 'Mobile Gateway'],
  ['public-gateway', 'Public Gateway'],
  ['edge-gateway', 'Edge Gateway'],
  ['payment-gateway', 'Payment Gateway'],
  ['admin-gateway', 'Admin Gateway'],
  ['partner-gateway', 'Partner Gateway'],
];

const API_NAMES = [
  ['rest-api', 'REST API'],
  ['public-api', 'Public API'],
  ['partner-api', 'Partner API'],
  ['internal-api', 'Internal API'],
  ['checkout-api', 'Checkout API'],
  ['reporting-api', 'Reporting API'],
];

const BFF_NAMES = [
  ['web-bff', 'Web BFF'],
  ['mobile-bff', 'Mobile BFF'],
  ['dashboard-bff', 'Dashboard BFF'],
];

const GRPC_NAMES = [
  ['grpc-gateway', 'gRPC Gateway'],
  ['grpc-api', 'gRPC API'],
];

const GRAPHQL_NAMES = [
  ['graphql-api', 'GraphQL API'],
  ['graph-api', 'Graph API'],
];

const SERVICE_NAMES = [
  ['user-service', 'User Service'],
  ['order-service', 'Order Service'],
  ['payment-service', 'Payment Service'],
  ['inventory-service', 'Inventory Service'],
  ['notification-service', 'Notification Service'],
  ['billing-service', 'Billing Service'],
  ['shipping-service', 'Shipping Service'],
  ['catalog-service', 'Catalog Service'],
  ['search-service', 'Search Service'],
  ['auth-proxy', 'Auth Proxy'],
  ['profile-service', 'Profile Service'],
  ['report-service', 'Report Service'],
  ['analytics-service', 'Analytics Service'],
  ['fraud-service', 'Fraud Detection'],
  ['compliance-service', 'Compliance Service'],
  ['fulfillment-service', 'Fulfillment Service'],
  ['recommendation-service', 'Recommendation Service'],
  ['pricing-service', 'Pricing Service'],
  ['tax-service', 'Tax Service'],
  ['review-service', 'Review Service'],
];

const DB_NAMES = [
  ['user-db', 'User DB', 'database'],
  ['order-db', 'Order DB', 'database'],
  ['payment-db', 'Payment DB', 'database'],
  ['inventory-db', 'Inventory DB', 'database'],
  ['main-postgres', 'Main Postgres', 'postgres'],
  ['analytics-db', 'Analytics DB', 'database'],
  ['audit-db', 'Audit DB', 'database'],
  ['session-cache', 'Session Cache', 'redis'],
  ['content-db', 'Content DB', 'mongodb'],
  ['ledger-db', 'Ledger DB', 'database'],
  ['archive-db', 'Archive DB', 'database'],
  ['events-table', 'Events Table', 'dynamo'],
  ['media-bucket', 'Media Bucket', 's3'],
];

const QUEUE_NAMES = [
  ['email-queue', 'Email Queue', 'queue'],
  ['order-events', 'Order Events', 'kafka'],
  ['notification-queue', 'Notification Queue', 'queue'],
  ['payment-events', 'Payment Events', 'kafka'],
  ['job-queue', 'Job Queue', 'queue'],
];

const AUTH_NAMES = [
  ['jwt-middleware', 'JWT Middleware', 'auth'],
  ['oauth-provider', 'OAuth Provider', 'oauth'],
  ['keycloak', 'Keycloak', 'keycloak'],
  ['okta', 'Okta IdP', 'okta'],
  ['auth-middleware', 'Auth Middleware', 'middleware'],
  ['iam-service', 'IAM Service', 'iam'],
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function pickHttpLike() {
  const pools = [GATEWAY_NAMES, API_NAMES, BFF_NAMES, GRPC_NAMES, GRAPHQL_NAMES];
  const pool = pick(pools);
  const [id, name] = pick(pool);
  let type = 'gateway';
  if (pool === API_NAMES) type = 'api';
  else if (pool === BFF_NAMES) type = 'bff';
  else if (pool === GRPC_NAMES) type = 'grpc';
  else if (pool === GRAPHQL_NAMES) type = 'graphql';
  return { id, name, type };
}

function pickDefaultHealthUrl() {
  return pick(['/health', '/healthz', '/ping']);
}

/** Use on HTTP-like nodes except generators that intentionally test IR-LINT-NO-HEALTHCHECK-003. */
function httpCleanConfig(extra = {}) {
  return { authRequired: true, url: pickDefaultHealthUrl(), ...extra };
}

function makeEdge(from, to, protocol = 'https') {
  return { from, to, metadata: { protocol } };
}

/** Keeps IR-LINT-SYNC-CHAIN-001 off clean layered graphs (async auth→service breaks sync depth). */
function makeAsyncEdge(from, to) {
  return { from, to, metadata: { protocol: 'async' } };
}

function runEngine(graph) {
  const ir = { graph };
  const norm = normalizeIrGraph(ir);
  if ('findings' in norm) {
    return { ok: false, structuralFindings: norm.findings, lintFindings: [] };
  }
  const structural = validateIrStructural(ir);
  const lint = validateIrLint(ir);
  const combined = [...structural, ...lint];
  return {
    ok: combined.every((f) => f.severity !== 'error'),
    structuralFindings: structural,
    lintFindings: lint,
    combined,
  };
}

function toPair(id, graph, result, variant) {
  return {
    id,
    instruction: 'Given this IR graph, what architecture violations exist?',
    variant,
    input: { graph },
    output: {
      ok: result.ok,
      violations: result.lintFindings.map((f) => ({
        code: f.code,
        severity: f.severity,
        nodeId: f.nodeId ?? null,
        message: f.message,
        fix: f.fixHint ?? null,
      })),
    },
  };
}

// ─── Graph generators ─────────────────────────────────────────────────────────

function genDirectDbAccess() {
  const http = pickHttpLike();
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'direct-db-access' };
}

function genCleanServiceLayer() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'clean-service-layer' };
}

function genMissingAuth() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'missing-auth' };
}

function genCleanWithAuth() {
  const http = pickHttpLike();
  const [authId, authName, authType] = pick(AUTH_NAMES);
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    { id: authId, type: authType, name: authName },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [
    makeEdge(http.id, authId),
    makeAsyncEdge(authId, svcId),
    makeEdge(svcId, dbId, 'tcp'),
  ];
  return { graph: { nodes, edges }, variant: 'clean-with-auth' };
}

function genCleanAuthConfig() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const authKey = pick(['authRequired', 'auth', 'security', 'authentication']);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: { [authKey]: true, url: '/health' } },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'clean-auth-config' };
}

function genHighFanout() {
  const http = pickHttpLike();
  const count = 5 + Math.floor(Math.random() * 4);
  const services = pickN(SERVICE_NAMES, count);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    ...services.map(([id, name]) => ({ id, type: 'service', name })),
  ];
  const edges = [];
  for (const [svcId] of services) {
    const [baseDbId, dbName, dbType] = pick(DB_NAMES);
    const dbId = `${baseDbId}__${svcId}`;
    nodes.push({ id: dbId, type: dbType, name: dbName });
    edges.push(makeEdge(http.id, svcId));
    edges.push(makeEdge(svcId, dbId, 'tcp'));
  }
  return { graph: { nodes, edges }, variant: 'high-fanout' };
}

function genSyncChain() {
  const http = pickHttpLike();
  const depth = 3 + Math.floor(Math.random() * 3);
  const services = pickN(SERVICE_NAMES, depth);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    ...services.map(([id, name]) => ({ id, type: 'service', name })),
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [];
  edges.push(makeEdge(http.id, services[0][0]));
  for (let i = 0; i < services.length - 1; i++) {
    edges.push(makeEdge(services[i][0], services[i + 1][0]));
  }
  edges.push(makeEdge(services[services.length - 1][0], dbId, 'tcp'));
  return { graph: { nodes, edges }, variant: 'sync-chain' };
}

function genCleanAsyncBreak() {
  const http = pickHttpLike();
  const [svc1Id, svc1Name] = pick(SERVICE_NAMES);
  const [qId, qName, qType] = pick(QUEUE_NAMES);
  const [svc2Id, svc2Name] = pick(SERVICE_NAMES.filter(([id]) => id !== svc1Id));
  const [svc3Id, svc3Name] = pick(SERVICE_NAMES.filter(([id]) => id !== svc1Id && id !== svc2Id));
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    { id: svc1Id, type: 'service', name: svc1Name },
    { id: qId, type: qType, name: qName },
    { id: svc2Id, type: 'service', name: svc2Name },
    { id: svc3Id, type: 'service', name: svc3Name },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [
    makeEdge(http.id, svc1Id),
    { from: svc1Id, to: qId, metadata: { protocol: 'amqp' } },
    { from: qId, to: svc2Id, metadata: { protocol: 'amqp' } },
    makeEdge(svc2Id, svc3Id),
    makeEdge(svc3Id, dbId, 'tcp'),
  ];
  return { graph: { nodes, edges }, variant: 'clean-async-break' };
}

function genNoHealthcheck() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    // Intentionally no health-like url — only this generator should omit it for 003.
    { id: http.id, type: http.type, name: http.name, config: { authRequired: true } },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'no-healthcheck' };
}

function genCleanHealthcheck() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const healthPath = pick(['/health', '/healthz', '/ping', '/status', '/ready', '/live']);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: { authRequired: true, url: healthPath } },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'clean-healthcheck' };
}

function genIsolatedNode() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const [orphanId, orphanName] = pick(SERVICE_NAMES.filter(([id]) => id !== svcId));
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
    { id: orphanId, type: 'service', name: orphanName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'isolated-node' };
}

function genDuplicateEdge() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'duplicate-edge' };
}

function genMissingName() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, config: { authRequired: true, url: pickDefaultHealthUrl() } },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'missing-name' };
}

function genDatastoreNoIncoming() {
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [db1Id, db1Name, db1Type] = pick(DB_NAMES);
  const [db2Id, db2Name, db2Type] = pick(DB_NAMES.filter(([id]) => id !== db1Id));
  const nodes = [
    { id: svcId, type: 'service', name: svcName },
    { id: db1Id, type: db1Type, name: db1Name },
    { id: db2Id, type: db2Type, name: db2Name },
  ];
  // db2 has no incoming edges (008) but outgoing to db1 so it is not IR-LINT-ISOLATED-NODE-005.
  const edges = [
    makeEdge(svcId, db1Id, 'tcp'),
    makeEdge(db2Id, db1Id, 'tcp'),
  ];
  return { graph: { nodes, edges }, variant: 'datastore-no-incoming' };
}

function genMultipleHttpEntries() {
  const http1 = pickHttpLike();
  let http2 = pickHttpLike();
  while (http2.id === http1.id) http2 = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http1.id, type: http1.type, name: http1.name, config: httpCleanConfig() },
    { id: http2.id, type: http2.type, name: http2.name, config: httpCleanConfig() },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [makeEdge(http1.id, svcId), makeEdge(http2.id, svcId), makeEdge(svcId, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'multiple-http-entries' };
}

function genDeadNode() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [deadId, deadName] = pick(SERVICE_NAMES.filter(([id]) => id !== svcId));
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig() },
    { id: svcId, type: 'service', name: svcName },
    { id: deadId, type: 'service', name: deadName },
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [
    makeEdge(http.id, svcId),
    makeEdge(http.id, deadId),
    makeEdge(svcId, dbId, 'tcp'),
  ];
  return { graph: { nodes, edges }, variant: 'dead-node' };
}

function genMultiViolation() {
  const http = pickHttpLike();
  const [svcId, svcName] = pick(SERVICE_NAMES);
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const [orphanId, orphanName] = pick(SERVICE_NAMES.filter(([id]) => id !== svcId));
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: { url: pickDefaultHealthUrl() } },
    { id: svcId, type: 'service', name: svcName },
    { id: dbId, type: dbType, name: dbName },
    { id: orphanId, type: 'service', name: orphanName },
  ];
  const edges = [makeEdge(http.id, svcId), makeEdge(http.id, dbId, 'tcp')];
  return { graph: { nodes, edges }, variant: 'multi-violation' };
}

function genCleanGraph() {
  const http = pickHttpLike();
  const [authId, authName, authType] = pick(AUTH_NAMES);
  const services = pickN(SERVICE_NAMES, 2 + Math.floor(Math.random() * 3));
  const [dbId, dbName, dbType] = pick(DB_NAMES);
  const healthPath = pick(['/health', '/healthz', '/ping', '/status']);
  const nodes = [
    { id: http.id, type: http.type, name: http.name, config: httpCleanConfig({ url: healthPath }) },
    { id: authId, type: authType, name: authName },
    ...services.map(([id, name]) => ({ id, type: 'service', name })),
    { id: dbId, type: dbType, name: dbName },
  ];
  const edges = [
    makeEdge(http.id, authId),
    ...services.map(([id]) => makeAsyncEdge(authId, id)),
    ...services.map(([id]) => makeEdge(id, dbId, 'tcp')),
  ];
  return { graph: { nodes, edges }, variant: 'clean-graph' };
}

const GENERATORS = [
  { fn: genHighFanout, weight: 12 },
  { fn: genMissingName, weight: 10 },
  { fn: genDuplicateEdge, weight: 8 },
  { fn: genDirectDbAccess, weight: 8 },
  { fn: genMissingAuth, weight: 8 },
  { fn: genDatastoreNoIncoming, weight: 8 },
  { fn: genMultiViolation, weight: 6 },
  { fn: genDeadNode, weight: 5 },
  { fn: genMultipleHttpEntries, weight: 5 },
  { fn: genNoHealthcheck, weight: 2 },
  { fn: genIsolatedNode, weight: 2 },
  { fn: genSyncChain, weight: 3 },
  { fn: genCleanServiceLayer, weight: 5 },
  { fn: genCleanWithAuth, weight: 5 },
  { fn: genCleanAuthConfig, weight: 4 },
  { fn: genCleanAsyncBreak, weight: 3 },
  { fn: genCleanHealthcheck, weight: 3 },
  { fn: genCleanGraph, weight: 8 },
];

const POOL = GENERATORS.flatMap(({ fn, weight }) => Array(weight).fill(fn));

function generateCorpus() {
  const TARGET_COUNT = parseInt(getArg('--count', '500'), 10);
  const OUT_PATH = resolve(ROOT, getArg('--out', 'corpus/auto-generated.jsonl'));

  console.log(`Generating ${TARGET_COUNT} corpus pairs...`);

  mkdirSync(resolve(ROOT, 'corpus'), { recursive: true });

  const lines = [];
  let skipped = 0;
  let attempts = 0;
  const seenGraphs = new Set();

  while (lines.length < TARGET_COUNT) {
    attempts++;
    if (attempts > TARGET_COUNT * 10) {
      console.warn(`Stopping after ${attempts} attempts — possible infinite loop.`);
      break;
    }

    const gen = pick(POOL);
    let graphDef;
    try {
      graphDef = gen();
    } catch {
      skipped++;
      continue;
    }

    const key = JSON.stringify(graphDef.graph);
    if (seenGraphs.has(key)) {
      skipped++;
      continue;
    }
    seenGraphs.add(key);

    let result;
    try {
      result = runEngine(graphDef.graph);
    } catch {
      skipped++;
      continue;
    }

    if (result.structuralFindings?.some((f) => f.severity === 'error')) {
      skipped++;
      continue;
    }

    const id = `gen-${lines.length}-${graphDef.variant}`;
    lines.push(JSON.stringify(toPair(id, graphDef.graph, result, graphDef.variant)));
  }

  writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');

  const pairs = lines.map((l) => JSON.parse(l));
  const withViolations = pairs.filter((p) => p.output.violations.length > 0).length;
  const withoutViolations = pairs.length - withViolations;
  const ruleCounts = {};
  for (const p of pairs) {
    for (const v of p.output.violations) {
      ruleCounts[v.code] = (ruleCounts[v.code] ?? 0) + 1;
    }
  }

  console.log(`\nDone.`);
  console.log(`  Written to: ${OUT_PATH}`);
  console.log(`  Total pairs: ${lines.length}`);
  console.log(`  With violations: ${withViolations}`);
  console.log(`  Clean (no lint violations): ${withoutViolations}`);
  console.log(`  Skipped (duplicates/errors): ${skipped}`);
  console.log(`\nViolation distribution:`);
  for (const [code, count] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${count}`);
  }
}

async function main() {
  if (!wantsGenerate) {
    await validateHandwritten();
    return;
  }
  try {
    readFileSync(join(ROOT, 'dist', 'index.js'), 'utf8');
  } catch {
    console.error('generate-corpus: run `npm run build` first (dist/index.js missing).');
    process.exitCode = 1;
    return;
  }
  generateCorpus();
}

main();
