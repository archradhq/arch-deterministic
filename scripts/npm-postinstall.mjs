/**
 * Optional install notice: one line + docs URL with version ref (inbound attribution only).
 * No runtime telemetry, no network calls. Skipped in CI and silent installs.
 *
 * Not enabled in package.json until 0.1.5 — add:
 *   "postinstall": "node scripts/npm-postinstall.mjs"
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
