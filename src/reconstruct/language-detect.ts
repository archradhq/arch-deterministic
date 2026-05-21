/**
 * Heuristic language detection from codebase root markers.
 */

import { readdir } from 'node:fs/promises';
import type { Language } from './types.js';

export async function detectLanguage(rootDir: string): Promise<Language> {
  let names: string[] = [];
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    names = entries.map((e) => e.name.toLowerCase());
  } catch {
    return 'nodejs';
  }

  // C# markers take priority — .csproj / .sln / global.json
  if (names.some((n) => n.endsWith('.csproj') || n.endsWith('.sln') || n === 'global.json')) {
    return 'csharp';
  }

  // Python markers
  const pyMarkers = new Set([
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'pipfile',
    'pipfile.lock',
    'poetry.lock',
    'manage.py', // Django
  ]);
  if (names.some((n) => pyMarkers.has(n))) return 'python';

  // Default: Node.js (package.json or unknown)
  return 'nodejs';
}
