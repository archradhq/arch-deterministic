#!/usr/bin/env node
/**
 * scan-corpus.mjs — run `scan` + `validate` over a pinned corpus of real
 * repositories and fail when the findings drift from what a human adjudicated.
 *
 * Why this exists: every scan-quality bug in this package was found by scanning a
 * real repository and reading the result by hand. That does not scale, and it
 * missed a regression once already — a merge change relabelled a Postgres
 * container as an HTTP gateway, and it was caught only because someone happened
 * to re-scan the same repository afterwards. This turns that luck into a check.
 *
 * Commits are pinned, so a difference here always means OUR behaviour changed.
 *
 *   node scripts/scan-corpus.mjs              compare against corpus/repos.json
 *   node scripts/scan-corpus.mjs --update     rewrite expectations (review the diff!)
 *   node scripts/scan-corpus.mjs --only NAME  restrict to one repo
 *   node scripts/scan-corpus.mjs --cache DIR  where to keep clones (default: .corpus-cache)
 *
 * Clones are shallow, fetched once and reused, so repeat runs are offline.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_PATH = join(ROOT, 'corpus', 'repos.json');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const UPDATE = process.argv.includes('--update');
const ONLY = arg('--only', null);
const CACHE = resolve(arg('--cache', join(ROOT, '.corpus-cache')));

const DIST = join(ROOT, 'dist', 'index.js');
if (!existsSync(DIST)) {
  console.error('scan-corpus: run `npm run build` first (dist/index.js missing).');
  process.exit(2);
}
// pathToFileURL, not the bare path: Windows absolute paths are not valid ESM specifiers.
const { scanCodebase, validateIrStructural, validateIrLint, hasIrStructuralErrors } = await import(
  pathToFileURL(DIST).href
);

/** Shallow-clone at a pinned commit, reusing an existing checkout when it matches. */
function ensureCheckout(repo) {
  const dir = join(CACHE, repo.name);
  if (existsSync(join(dir, '.git'))) {
    try {
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (head === repo.commit) return dir;
    } catch {
      /* fall through and re-clone */
    }
  }
  mkdirSync(CACHE, { recursive: true });
  // `--revision` needs a modern git; fall back to fetching the single commit.
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' });
  try {
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', repo.url], { stdio: 'pipe' });
  } catch {
    /* remote already present */
  }
  execFileSync('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', repo.commit], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD'], { stdio: 'pipe' });
  return dir;
}

/** Findings for one checkout, counted by rule code. */
async function findingsFor(dir) {
  const result = await scanCodebase({ from: dir });
  const structural = validateIrStructural(result.ir);
  const lint = hasIrStructuralErrors(structural) ? [] : validateIrLint(result.ir);
  const counts = {};
  for (const f of lint) counts[f.code] = (counts[f.code] ?? 0) + 1;
  return {
    nodeCount: result.ir.graph.nodes.length,
    counts,
    structuralCount: structural.length,
  };
}

/** Human-readable difference between expected and actual code counts. */
function diffCounts(expected, actual) {
  const drift = [];
  for (const code of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const want = expected[code] ?? 0;
    const got = actual[code] ?? 0;
    if (want !== got) drift.push(`${code}: expected ${want}, got ${got}`);
  }
  return drift.sort();
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
const repos = corpus.repos.filter((r) => !ONLY || r.name === ONLY);
if (repos.length === 0) {
  console.error(`scan-corpus: no repo matched --only ${ONLY}`);
  process.exit(2);
}

let failed = 0;
for (const repo of repos) {
  process.stdout.write(`\n── ${repo.name}\n`);
  let dir;
  try {
    dir = ensureCheckout(repo);
  } catch (e) {
    console.error(`   CLONE FAILED: ${String(e).slice(0, 200)}`);
    failed += 1;
    continue;
  }

  const started = Date.now();
  const { nodeCount, counts, structuralCount } = await findingsFor(dir);
  const ms = Date.now() - started;

  if (UPDATE) {
    repo.expectedNodes = nodeCount;
    repo.expected = counts;
    if (structuralCount > 0) repo.expectedStructural = structuralCount;
    console.log(`   updated: ${nodeCount} nodes, ${Object.keys(counts).length} finding codes (${ms}ms)`);
    continue;
  }

  const drift = diffCounts(repo.expected ?? {}, counts);
  const nodeDrift = repo.expectedNodes !== undefined && repo.expectedNodes !== nodeCount;
  // A draft IR should be structurally valid, so the default expectation is zero
  // and a repo must opt out explicitly. The one legitimate exception so far is a
  // repository we can read nothing from: a Helm chart collection scans to an
  // empty graph, which is the honest answer and still trips EMPTY_GRAPH.
  const expectedStructural = repo.expectedStructural ?? 0;
  const structuralDrift = structuralCount !== expectedStructural;
  if (structuralDrift) {
    console.error(
      `   ✗ ${structuralCount} STRUCTURAL finding(s), expected ${expectedStructural} — draft IR should always be structurally valid`,
    );
  }
  if (nodeDrift) {
    console.error(`   ✗ node count: expected ${repo.expectedNodes}, got ${nodeCount}`);
  }
  for (const d of drift) console.error(`   ✗ ${d}`);

  if (!nodeDrift && drift.length === 0 && !structuralDrift) {
    console.log(`   ✓ ${nodeCount} nodes, findings match adjudication (${ms}ms)`);
  } else {
    failed += 1;
    const note = repo.notes && Object.keys(repo.notes)[0];
    if (note) console.error(`     context: ${repo.notes[note]}`);
  }
}

if (UPDATE) {
  writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`\nscan-corpus: expectations rewritten. Review the diff before committing —\nan expectation changed without a reason is a regression you just blessed.`);
  process.exit(0);
}

if (failed > 0) {
  console.error(
    `\nscan-corpus: ${failed} repo(s) drifted from adjudication.\n` +
      `If the new behaviour is CORRECT, re-run with --update and explain the change in the\n` +
      `commit message and in corpus/repos.json notes. If it is not, you have a regression.`,
  );
  process.exit(1);
}
console.log(`\nscan-corpus: ${repos.length} repo(s) match adjudication.`);
