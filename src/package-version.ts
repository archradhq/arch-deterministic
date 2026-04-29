import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read `version` from the shipped `package.json` relative to a built entry
 * (`dist/*.js` → `../package.json`). Keeps CLI `--version` and MCP `serverInfo`
 * aligned with the published npm tag.
 */
export function readPackageVersion(importMetaUrl: string | URL): string {
  try {
    const here = dirname(fileURLToPath(importMetaUrl));
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    if (pkg.version && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // fall through
  }
  return '0.0.0-unknown';
}
