/**
 * archrad.yml — project-level configuration for the archrad CLI.
 *
 * The loader looks for `archrad.yml` (or `archrad.yaml`) starting from the
 * current working directory and walking upward toward the filesystem root.
 * When found, its values are used as **defaults** for matching CLI options;
 * explicit flags on the command line always win.
 *
 * Supported shape (version: 1):
 *
 *   version: 1
 *   ir: ./archrad-graph.json      # default --ir for validate / export / drift
 *   target: python                # default --target for export / drift
 *   output: ./generated           # default --out / --output
 *   policies: ./policies          # default --policies
 *   failOn: error                 # default --fail-on for validate
 *   failOnWarning: false          # default --fail-on-warning
 *   maxWarnings: 0                # default --max-warnings
 *   hostPort: 8080                # default --host-port
 *   skipLint: false               # validate: --skip-lint
 *   skipIrLint: false             # export / drift: --skip-ir-lint
 *   irLintProfile: default       # validate / lint / export / drift — monolith-relaxed omits layered-service rules
 *   strictExtra: false            # drift: --strict-extra
 *   strictHostPort: false         # export: --strict-host-port
 *   skipHostPortCheck: false      # export / drift: --skip-host-port-check
 *   report: ./archrad-report.html # validate: --report
 *   findingsJsonOut: ./archrad-findings.json
 *   metricsFile: ./archrad-metrics.json
 *
 * File-path values are resolved relative to the directory that contains the
 * config file, so `archrad validate` behaves consistently regardless of which
 * subdirectory the user invokes it from.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import * as YAML from 'js-yaml';
import { z } from 'zod';

export const CONFIG_FILE_NAMES = ['archrad.yml', 'archrad.yaml'] as const;

const FailOnModeSchema = z.enum(['error', 'warning', 'never']);

export const ArchradConfigSchema = z
  .object({
    version: z.literal(1).optional(),

    // Inputs
    ir: z.string().optional(),
    target: z.enum(['python', 'node', 'nodejs']).optional(),
    output: z.string().optional(),

    // Policy + exit behaviour
    policies: z.string().optional(),
    failOn: FailOnModeSchema.optional(),
    failOnWarning: z.boolean().optional(),
    maxWarnings: z.number().int().nonnegative().optional(),

    // Lint toggles
    skipLint: z.boolean().optional(),
    skipIrLint: z.boolean().optional(),
    irLintProfile: z.enum(['default', 'monolith-relaxed']).optional(),

    // Export/drift specifics
    hostPort: z
      .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
      .optional(),
    skipHostPortCheck: z.boolean().optional(),
    strictHostPort: z.boolean().optional(),
    strictExtra: z.boolean().optional(),

    // Output artefacts
    report: z.string().optional(),
    findingsJsonOut: z.string().optional(),
    metricsFile: z.string().optional(),
    policiesRequireSigned: z.boolean().optional(),
    cosignPubkey: z.string().optional(),
  })
  .strict();

export type ArchradConfig = z.infer<typeof ArchradConfigSchema>;

/** Keys whose string values should be resolved relative to the config dir. */
const PATH_KEYS: ReadonlySet<keyof ArchradConfig> = new Set([
  'ir',
  'output',
  'policies',
  'report',
  'findingsJsonOut',
  'metricsFile',
  'cosignPubkey',
]);

export interface LoadedArchradConfig {
  /** Parsed, validated configuration. */
  config: ArchradConfig;
  /** Absolute path to the config file that produced `config`. */
  configPath: string;
  /** Absolute path to the directory containing the config file. */
  configDir: string;
}

export class ArchradConfigError extends Error {
  readonly path: string | null;
  constructor(message: string, path: string | null = null) {
    super(message);
    this.name = 'ArchradConfigError';
    this.path = path;
  }
}

/**
 * Walk upward from `startDir` looking for a config file. Stops at the
 * filesystem root. Returns `null` when no config is found.
 */
export function findArchradConfigFile(startDir: string): string | null {
  let current = resolve(startDir);
  let prev = '';
  while (current && current !== prev) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolve(current, name);
      if (existsSync(candidate)) return candidate;
    }
    prev = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function parseAndValidate(raw: string, absPath: string): ArchradConfig {
  let parsed: unknown;
  try {
    parsed = YAML.load(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ArchradConfigError(`could not parse ${absPath}: ${msg}`, absPath);
  }
  if (parsed == null) {
    return ArchradConfigSchema.parse({});
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArchradConfigError(
      `${absPath}: top-level must be a YAML mapping, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      absPath
    );
  }
  const result = ArchradConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((iss) => `  - ${iss.path.join('.') || '<root>'}: ${iss.message}`)
      .join('\n');
    throw new ArchradConfigError(`${absPath}: invalid config\n${issues}`, absPath);
  }
  return result.data;
}

/** Read and validate an archrad config file (async). */
export async function readArchradConfigFile(
  configPath: string
): Promise<LoadedArchradConfig> {
  const absPath = resolve(configPath);
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') {
      throw new ArchradConfigError(`config file not found: ${absPath}`, absPath);
    }
    throw new ArchradConfigError(
      `could not read config file: ${absPath} (${e?.message ?? String(err)})`,
      absPath
    );
  }
  const config = parseAndValidate(raw, absPath);
  return { config, configPath: absPath, configDir: dirname(absPath) };
}

/** Read and validate an archrad config file (sync — used by CLI bootstrap). */
export function readArchradConfigFileSync(configPath: string): LoadedArchradConfig {
  const absPath = resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') {
      throw new ArchradConfigError(`config file not found: ${absPath}`, absPath);
    }
    throw new ArchradConfigError(
      `could not read config file: ${absPath} (${e?.message ?? String(err)})`,
      absPath
    );
  }
  const config = parseAndValidate(raw, absPath);
  return { config, configPath: absPath, configDir: dirname(absPath) };
}

export interface LoadArchradConfigOptions {
  startDir?: string;
  configPath?: string | null;
  disabled?: boolean;
}

/** Discover (or accept a path to) and load the project config. Async. */
export async function loadArchradConfig(
  opts: LoadArchradConfigOptions = {}
): Promise<LoadedArchradConfig | null> {
  if (opts.disabled) return null;
  if (opts.configPath) return readArchradConfigFile(opts.configPath);
  const found = findArchradConfigFile(opts.startDir ?? process.cwd());
  return found ? readArchradConfigFile(found) : null;
}

/** Discover (or accept a path to) and load the project config. Sync. */
export function loadArchradConfigSync(
  opts: LoadArchradConfigOptions = {}
): LoadedArchradConfig | null {
  if (opts.disabled) return null;
  if (opts.configPath) return readArchradConfigFileSync(opts.configPath);
  const found = findArchradConfigFile(opts.startDir ?? process.cwd());
  return found ? readArchradConfigFileSync(found) : null;
}

/**
 * Resolve a config-relative path into an absolute path. Absolute paths
 * are returned unchanged. Returns `undefined` for empty input.
 */
export function resolveConfigPath(
  value: string | undefined,
  configDir: string
): string | undefined {
  if (value == null || value === '') return undefined;
  if (isAbsolute(value)) return value;
  return resolve(configDir, value);
}

/**
 * Convert a config value into the shape a CLI option default expects.
 * Paths resolve relative to the config directory; numeric values that
 * map to string-typed flags (e.g. `--max-warnings`) get stringified.
 */
export function coerceConfigValueForCli(
  key: keyof ArchradConfig,
  value: unknown,
  configDir: string
): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && PATH_KEYS.has(key)) {
    return resolveConfigPath(value, configDir);
  }
  if (key === 'maxWarnings' && typeof value === 'number') {
    return String(value);
  }
  if (key === 'hostPort') {
    return String(value);
  }
  return value;
}

/**
 * Format a stderr line describing which config file (if any) was used.
 * Returns null when no config was loaded.
 */
export function describeLoadedConfig(
  loaded: LoadedArchradConfig | null
): string | null {
  if (!loaded) return null;
  const cwd = process.cwd();
  let pathStr = loaded.configPath;
  if (pathStr.startsWith(cwd + sep)) {
    pathStr = '.' + sep + pathStr.slice(cwd.length + 1);
  }
  return `archrad: using config from ${pathStr}`;
}
