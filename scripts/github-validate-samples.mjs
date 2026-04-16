#!/usr/bin/env node
/**
 * List YAML in any public GitHub repo (Git Tree API — no token), fetch raw files,
 * heuristically classify ArchRad blueprint vs OpenAPI 3.x, then `yaml-to-ir` / `ingest openapi` + `validate`.
 *
 * Usage (from packages/deterministic after `npm run build`):
 *   node scripts/github-validate-samples.mjs
 *   node scripts/github-validate-samples.mjs --repo OAI/OpenAPI-Specification --prefix examples/v3.0/ --ref main --max 5
 *   node scripts/github-validate-samples.mjs --repo archradhq/arch-deterministic --prefix fixtures/ --max 4
 *
 * Optional: GITHUB_TOKEN in env — raises rate limits only (not required for public repos).
 *
 * Repo selection:
 *   --repo owner/name          (explicit; use this for any public repo)
 *   --random-repo              pick a different curated repo each run (see SAMPLE_REPOS in script)
 *   ARCHRAD_VALIDATE_REPO=…    default repo when you omit --repo (not used if --random-repo)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'archrad-github-validate-samples (+https://github.com/archradhq/arch-deterministic)';
const MAX_BODY = 512 * 1024;

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const cliJs = join(pkgRoot, 'dist', 'cli.js');

/** Curated public repos (OpenAPI / fixtures). Ref/prefix tuned so scans find YAML quickly. */
const SAMPLE_REPOS = [
  { repo: 'swagger-api/swagger-petstore', ref: 'main', prefix: '' },
  { repo: 'archradhq/arch-deterministic', ref: 'main', prefix: 'fixtures/' },
  {
    repo: 'OAI/OpenAPI-Specification',
    ref: 'main',
    prefix: '_archive_/schemas/v3.0/pass/',
  },
];

function parseArgs(argv) {
  const out = {
    repo: 'archradhq/arch-deterministic',
    ref: 'main',
    prefix: '',
    maxValidate: 8,
    scanLimit: 2000,
    quiet: false,
    randomRepo: false,
    listSampleRepos: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--repo' && a[i + 1]) {
      out.repo = a[++i];
      continue;
    }
    if (a[i] === '--ref' && a[i + 1]) {
      out.ref = a[++i];
      continue;
    }
    if (a[i] === '--prefix') {
      // If next token is another flag (e.g. PowerShell dropped "" after --prefix), leave prefix empty.
      let p = '';
      if (i + 1 < a.length && !String(a[i + 1]).startsWith('-')) {
        p = a[++i];
      }
      if (p && !p.endsWith('/')) p += '/';
      out.prefix = p;
      continue;
    }
    if (a[i] === '--max' && a[i + 1]) {
      out.maxValidate = Math.max(1, parseInt(a[++i], 10) || 8);
      continue;
    }
    if (a[i] === '--scan-limit' && a[i + 1]) {
      out.scanLimit = Math.max(100, parseInt(a[++i], 10) || 2000);
      continue;
    }
    if (a[i] === '--help' || a[i] === '-h') {
      out.help = true;
    }
    if (a[i] === '--quiet' || a[i] === '-q') {
      out.quiet = true;
    }
    if (a[i] === '--random-repo') {
      out.randomRepo = true;
    }
    if (a[i] === '--list-sample-repos') {
      out.listSampleRepos = true;
    }
  }
  return out;
}

function applyRepoSelection(argvSlice, opts) {
  if (opts.randomRepo) {
    const pick = SAMPLE_REPOS[Math.floor(Math.random() * SAMPLE_REPOS.length)];
    opts.repo = pick.repo;
    opts.ref = pick.ref ?? 'main';
    opts.prefix = pick.prefix ?? '';
    opts._randomPick = pick;
    return;
  }
  if (!argvSlice.includes('--repo')) {
    const envRepo = process.env.ARCHRAD_VALIDATE_REPO?.trim();
    if (envRepo) opts.repo = envRepo;
  }
}

/** Summarize `archrad validate --json` stdout (finding counts by rule code). */
function summarizeValidateJson(jsonText) {
  try {
    const arr = JSON.parse(jsonText.trim());
    if (!Array.isArray(arr)) return null;
    const byCode = {};
    let warnings = 0;
    let errors = 0;
    for (const f of arr) {
      if (f.severity === 'warning') warnings++;
      else if (f.severity === 'error') errors++;
      const c = f.code ?? '?';
      byCode[c] = (byCode[c] || 0) + 1;
    }
    const parts = Object.entries(byCode)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}×${n}`);
    return { total: arr.length, warnings, errors, parts: parts.join(', ') };
  } catch {
    return null;
  }
}

function rawUrl(repo, ref, pathInRepo) {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${pathInRepo}`;
}

async function fetchTree(repo, ref, token) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub tree API ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.tree.filter((e) => e.type === 'blob' && /\.(ya?ml)$/i.test(e.path)).map((e) => e.path);
}

async function fetchDefaultBranch(repo, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub repo API ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.default_branch;
}

/** If `git/trees/{ref}` 404s (e.g. default is `master` but we used `main`), retry with `default_branch`. */
async function fetchTreeWithFallback(repo, ref, token) {
  try {
    const paths = await fetchTree(repo, ref, token);
    return { paths, ref };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('404')) throw e;
    const def = await fetchDefaultBranch(repo, token);
    if (def === ref) throw e;
    console.log(`Git tree for ref "${ref}" not found — using repo default branch "${def}".`);
    const paths = await fetchTree(repo, def, token);
    return { paths, ref: def };
  }
}

/** @returns {'openapi' | 'blueprint' | null} */
function classifyYaml(text) {
  const head = text.slice(0, Math.min(text.length, 16384));
  // Kubernetes / unrelated manifests — skip (reduces noise)
  if (/^\s*apiVersion\s*:/m.test(head) && /^\s*kind\s*:/m.test(head) && !/^\s*openapi\s*:/m.test(head)) {
    return null;
  }
  if (/^\s*openapi\s*:/m.test(head) || /^\s*swagger\s*:\s*['"]?2/m.test(head)) {
    return 'openapi';
  }
  if (/^\s*graph\s*:/m.test(head) || /^\s*nodes\s*:/m.test(head)) {
    return 'blueprint';
  }
  return null;
}

function run(args) {
  return spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function fetchText(url, token) {
  const headers = {
    'User-Agent': UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BODY) throw new Error(`body too large (${buf.byteLength} bytes)`);
  return new TextDecoder('utf8', { fatal: false }).decode(buf);
}

const opts = parseArgs(process.argv);
applyRepoSelection(process.argv.slice(2), opts);

function printValidateResult(filePath, label, r2) {
  if (opts.quiet) {
    const s = summarizeValidateJson(r2.stdout);
    if (s) {
      console.log(
        `${r2.status === 0 ? '✓' : '✗'} ${filePath}  (${label})  exit ${r2.status}  —  ${s.total} finding(s) (${s.errors} err, ${s.warnings} warn): ${s.parts}`,
      );
    } else {
      console.log(`${r2.status === 0 ? '✓' : '✗'} ${filePath}  (${label})  exit ${r2.status}`);
    }
    return;
  }
  console.log(`\n--- ${filePath} (${label}) exit ${r2.status} ---`);
  console.log(r2.stdout || r2.stderr || '');
}

if (opts.listSampleRepos) {
  for (const s of SAMPLE_REPOS) {
    const pr = s.prefix ?? '';
    console.log(`${s.repo}  ref=${s.ref ?? 'main'}  prefix=${pr ? pr : '(whole tree)'}`);
  }
  process.exit(0);
}

if (opts.help) {
  console.log(`Usage: node scripts/github-validate-samples.mjs [options]

  --repo owner/name     Public repository (default: archradhq/arch-deterministic)
  --ref branch-or-sha   Git ref for tree + raw URLs (default: main; auto-falls back to GitHub default_branch on 404)
  --prefix path/        Only YAML under this path (omit flag for whole repo; avoid "" in PowerShell)
  --max N               Stop after N successful classify + validate attempts (default: 8)
  --scan-limit N        Max YAML paths to fetch before giving up (default: 2000)
  --quiet, -q           One line per file (uses validate --json); no long lint wall
  --random-repo         Pick a random repo from the built-in list (overrides default; ignores ARCHRAD_VALIDATE_REPO)
  --list-sample-repos   Print SAMPLE_REPOS and exit

  Default repo if you omit --repo: archradhq/arch-deterministic, or set env ARCHRAD_VALIDATE_REPO=owner/name

Uses https://api.github.com/repos/{repo}/git/trees/{ref} (no auth for public repos).
Set GITHUB_TOKEN to reduce rate-limit errors when scanning large trees.
`);
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

let refUsed = opts.ref;

const randomNote = opts._randomPick ? ' [random from SAMPLE_REPOS]' : '';
console.log(
  `Repo ${opts.repo} @ ${refUsed}${opts.prefix ? ` (prefix: ${opts.prefix})` : ''}${randomNote} — max ${opts.maxValidate} validation(s), scan ≤${opts.scanLimit} YAML paths\n`,
);

let paths;
try {
  const r = await fetchTreeWithFallback(opts.repo, opts.ref, token);
  paths = r.paths;
  refUsed = r.ref;
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}

if (opts.prefix) {
  paths = paths.filter((p) => p.startsWith(opts.prefix));
}

paths.sort();

const tmp = mkdtempSync(join(pkgRoot, 'dist-github-validate-'));

let ok = 0;
let fail = 0;
let skipped = 0;
let scanned = 0;
let runs = 0;

try {
  for (const p of paths) {
    if (runs >= opts.maxValidate) break;
    if (scanned >= opts.scanLimit) break;
    scanned++;

    const url = rawUrl(opts.repo, refUsed, p);
    let text;
    try {
      text = await fetchText(url, token);
    } catch (e) {
      skipped++;
      continue;
    }

    const kind = classifyYaml(text);
    if (!kind) {
      skipped++;
      continue;
    }

    runs++;
    const out = join(tmp, `out_${runs}.json`);

    if (kind === 'blueprint') {
      const r1 = run(['yaml-to-ir', '-y', url, '-o', out]);
      if (r1.status !== 0) {
        console.error(`\nFAIL yaml-to-ir ${p}\n${r1.stderr || r1.stdout}`);
        fail++;
        continue;
      }
      const r2 = run(
        opts.quiet ? ['validate', '--ir', out, '--json'] : ['validate', '--ir', out],
      );
      printValidateResult(p, 'blueprint → yaml-to-ir → validate', r2);
      if (r2.status === 0) ok++;
      else fail++;
      continue;
    }

    const r1 = run(['ingest', 'openapi', '-s', url, '-o', out]);
    if (r1.status !== 0) {
      console.error(`\nFAIL ingest openapi ${p}\n${r1.stderr || r1.stdout}`);
      fail++;
      continue;
    }
    const r2 = run(
      opts.quiet ? ['validate', '--ir', out, '--json'] : ['validate', '--ir', out],
    );
    printValidateResult(p, 'ingest openapi → validate', r2);
    if (r2.status === 0) ok++;
    else fail++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `\nDone. validate exit 0: ${ok}, validate exit non-zero: ${fail}, skipped (unclassified or fetch error): ${skipped}, YAML paths scanned: ${scanned}/${paths.length}`,
);
if (fail) process.exit(1);
