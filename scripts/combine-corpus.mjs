#!/usr/bin/env node
/**
 * combine-corpus.mjs
 *
 * Combines all hand-written corpus JSON files and auto-generated JSONL
 * into a single combined.jsonl ready for train/val/test splitting.
 *
 * Usage:
 *   node scripts/combine-corpus.mjs
 *   node scripts/combine-corpus.mjs --out corpus/combined.jsonl
 *
 * Input:
 *   corpus/*.json          (hand-written pairs — array of objects)
 *   corpus/auto-generated.jsonl  (auto-generated pairs — one object per line)
 *
 * Output:
 *   corpus/combined.jsonl  (one JSON object per line, shuffled)
 *
 * Provenance: each line includes instruction/input/output plus `_source` (corpus
 * filename) and any `_…` fields from the source row (e.g. `_source_url`, `_license`,
 * `_source_catalog`, Stack Overflow `_source_id`, …) for licensing attribution.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../archlora/');
const CORPUS_DIR = resolve(ROOT, 'corpus');


const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const OUT_PATH = resolve(ROOT, getArg('--out', 'corpus/combined.jsonl'));
const SEED = parseInt(getArg('--seed', '42'), 10);

// ─── Seeded shuffle (reproducible) ───────────────────────────────────────────

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function shuffle(arr, seed) {
  const rand = seededRandom(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Merge instruction/input/output with `_source` (corpus file) and all `_…` keys from source. */
function pairFromJsonlRow(obj, corpusFilename) {
  const row = {
    instruction: obj.instruction,
    input: obj.input,
    output: obj.output,
  };
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'instruction' || k === 'input' || k === 'output') continue;
    if (k.startsWith('_')) row[k] = v;
  }
  if (obj.variant != null && row._variant === undefined) row._variant = obj.variant;
  row._source = corpusFilename;
  return row;
}

/** Hand-written JSON array entries: same provenance rules. */
function pairFromHandwritten(pair, corpusFilename) {
  return pairFromJsonlRow(
    { ...pair, instruction: pair.instruction, input: pair.input, output: pair.output },
    corpusFilename,
  );
}

// ─── Load hand-written JSON files ────────────────────────────────────────────

function loadJsonFiles() {
  const files = readdirSync(CORPUS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .sort();

  const pairs = [];
  const stats = [];

  for (const file of files) {
    const path = resolve(CORPUS_DIR, file);
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      console.error(`  ERROR: could not parse ${file}: ${e.message}`);
      process.exitCode = 1;
      continue;
    }

    if (!Array.isArray(raw)) {
      console.error(`  ERROR: ${file} is not a JSON array — skipping`);
      process.exitCode = 1;
      continue;
    }

    let valid = 0;
    for (const pair of raw) {
      if (!pair.instruction || !pair.input || !pair.output) {
        console.warn(`  WARN: ${file} has a pair missing instruction/input/output — skipping that pair`);
        continue;
      }
      pairs.push(pairFromHandwritten(pair, file));
      valid++;
    }
    stats.push({ file, count: valid });
  }

  return { pairs, stats };
}

// ─── Load auto-generated JSONL ────────────────────────────────────────────────

function loadJsonlFile(filename) {
  const path = resolve(CORPUS_DIR, filename);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    console.warn(`  WARN: ${filename} not found — skipping`);
    return { pairs: [], count: 0 };
  }

  const lines = raw.split('\n').filter(l => l.trim());
  const pairs = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj.instruction || !obj.input || !obj.output) continue;
      pairs.push(pairFromJsonlRow(obj, filename));
    } catch (e) {
      console.warn(`  WARN: skipping invalid JSON line in ${filename}`);
    }
  }

  return { pairs, count: pairs.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('Combining corpus...\n');

  // Load hand-written pairs
  const { pairs: handWritten, stats: jsonStats } = loadJsonFiles();
  console.log('Hand-written JSON files:');
  for (const s of jsonStats) {
    console.log(`  ${s.file}: ${s.count} pairs`);
  }
  console.log(`  Subtotal: ${handWritten.length} pairs\n`);

  // Load auto-generated pairs
  const { pairs: autoGenerated, count: autoCount } = loadJsonlFile('auto-generated.jsonl');
  console.log(`Auto-generated JSONL: ${autoCount} pairs\n`);

  // Load augmented pairs
  const { pairs: augmented, count: augCount } = loadJsonlFile('augmented.jsonl');
  console.log(`Augmented JSONL: ${augCount} pairs\n`);

  const { pairs: adrScraped, count: adrCount } = loadJsonlFile('adr-scraped.jsonl');
  console.log(`ADR scraped JSONL: ${adrCount} pairs\n`);

  const { pairs: apisGuru, count: apisGuruCount } = loadJsonlFile('apis-guru-scraped.jsonl');
  console.log(`APIs.guru scraped JSONL: ${apisGuruCount} pairs\n`);

  const { pairs: stackoverflow, count: soCount } = loadJsonlFile('stackoverflow-scraped.jsonl');
  console.log(`Stack Overflow scraped JSONL: ${soCount} pairs\n`);

  // Combine
  const all = [
    ...handWritten,
    ...autoGenerated,
    ...augmented,
    ...adrScraped,
    ...apisGuru,
    ...stackoverflow,
  ];
  console.log(`Total before shuffle: ${all.length} pairs`);

  // Deduplicate by input+output fingerprint
  const seen = new Set();
  const deduped = [];
  let dupeCount = 0;
  for (const pair of all) {
    const key = JSON.stringify(pair.input) + JSON.stringify(pair.output);
    if (seen.has(key)) {
      dupeCount++;
      continue;
    }
    seen.add(key);
    deduped.push(pair);
  }
  if (dupeCount > 0) {
    console.log(`Removed ${dupeCount} duplicate pairs`);
  }

    // Cap clean graphs at 30% of total
    const violationPairs = deduped.filter(p => (p.output?.violations ?? []).length > 0);
    const cleanPairs = deduped.filter(p => (p.output?.violations ?? []).length === 0);
    const maxClean = Math.floor(violationPairs.length * 0.43);
    const cappedClean = cleanPairs.slice(0, maxClean);
    const capped = [...violationPairs, ...cappedClean];
    console.log(`Clean ratio capped: ${cleanPairs.length} → ${cappedClean.length} (${(100*cappedClean.length/capped.length).toFixed(1)}% of total)`);
  

  // Shuffle with fixed seed for reproducibility
  const shuffled = shuffle(capped, SEED);
  console.log(`Total after dedup + shuffle: ${shuffled.length} pairs`);

  // Violation distribution
  const ruleCounts = {};
  let withViolations = 0;
  let clean = 0;
  for (const pair of shuffled) {
    const violations = pair.output?.violations ?? [];
    if (violations.length === 0) {
      clean++;
    } else {
      withViolations++;
      for (const v of violations) {
        if (v.code) ruleCounts[v.code] = (ruleCounts[v.code] ?? 0) + 1;
      }
    }
  }

  console.log(`\nViolation distribution:`);
  console.log(`  With violations: ${withViolations}`);
  console.log(`  Clean:           ${clean} (${(100 * clean / shuffled.length).toFixed(1)}%)`);
  for (const [code, count] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code}: ${count}`);
  }

  // Write output (full row: instruction/input/output + provenance `_…`)
  const lines = shuffled.map(p => JSON.stringify(p));
  writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');

  console.log(`\nWritten to: ${OUT_PATH}`);
  console.log(`Total pairs: ${shuffled.length}`);
}

main();
