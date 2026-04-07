/**
 * Optional install notice (not wired from package.json by default).
 * Skipped in CI and silent installs. Enable only if you want a local console line on `npm install`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true' || process.env.GITLAB_CI === 'true') {
  process.exit(0);
}
if (process.env.npm_config_loglevel === 'silent') {
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const v = pkg.version;
const url = `https://archrad.com/docs/drift?ref=npm-${encodeURIComponent(v)}`;
console.log(`\n  ${pkg.name}@${v} — Drift in CI (docs only; no package telemetry): ${url}\n`);
