/**
 * Bridge between {@link loadArchradConfigSync} and the Commander program:
 * walks every subcommand and sets option defaults from `archrad.yml`.
 *
 * Defaults never clobber CLI flags (Commander tracks explicit values vs.
 * defaults), and setting a default satisfies `requiredOption()`, so a
 * user can run `archrad validate` with no flags when `ir:` is in config.
 */

import { Command, Option } from 'commander';
import {
  coerceConfigValueForCli,
  loadArchradConfigSync,
  type ArchradConfig,
  type LoadedArchradConfig,
} from './config.js';

/**
 * Map of (command path) → (config key → Commander option attribute name).
 * Command path uses the full name chain (e.g. `ingest openapi`).
 */
type CommandConfigMap = Record<string, Partial<Record<keyof ArchradConfig, string>>>;

const COMMAND_CONFIG_MAP: CommandConfigMap = {
  init: {
    // init's `--output <path>` attr → `output`
    output: 'output',
  },
  validate: {
    ir: 'ir',
    skipLint: 'skipLint',
    policies: 'policies',
    policiesRequireSigned: 'policiesRequireSigned',
    cosignPubkey: 'cosignPubkey',
    failOnWarning: 'failOnWarning',
    maxWarnings: 'maxWarnings',
    failOn: 'failOn',
    report: 'report',
    metricsFile: 'metricsFile',
    findingsJsonOut: 'findingsJsonOut',
    irLintProfile: 'irLintProfile',
    codebase: 'codebase',
    codebaseLanguage: 'codebaseLanguage',
    codebaseExclude: 'codebaseExclude',
    implDriftFailOn: 'implDriftFailOn',
  },
  reconstruct: {
    codebase: 'from',
    codebaseLanguage: 'language',
    codebaseExclude: 'exclude',
    output: 'output',
  },
  lint: {
    ir: 'ir',
    policies: 'policies',
    policiesRequireSigned: 'policiesRequireSigned',
    cosignPubkey: 'cosignPubkey',
    failOnWarning: 'failOnWarning',
    maxWarnings: 'maxWarnings',
    failOn: 'failOn',
    report: 'report',
    metricsFile: 'metricsFile',
    findingsJsonOut: 'findingsJsonOut',
    irLintProfile: 'irLintProfile',
  },
  export: {
    ir: 'ir',
    target: 'target',
    // export's `--out <dir>` attr → `out`
    output: 'out',
    hostPort: 'hostPort',
    skipHostPortCheck: 'skipHostPortCheck',
    strictHostPort: 'strictHostPort',
    skipIrLint: 'skipIrLint',
    policies: 'policies',
    policiesRequireSigned: 'policiesRequireSigned',
    cosignPubkey: 'cosignPubkey',
    failOnWarning: 'failOnWarning',
    maxWarnings: 'maxWarnings',
    irLintProfile: 'irLintProfile',
  },
  'validate-drift': {
    ir: 'ir',
    target: 'target',
    output: 'out',
    hostPort: 'hostPort',
    skipHostPortCheck: 'skipHostPortCheck',
    skipIrLint: 'skipIrLint',
    policies: 'policies',
    policiesRequireSigned: 'policiesRequireSigned',
    cosignPubkey: 'cosignPubkey',
    strictExtra: 'strictExtra',
    irLintProfile: 'irLintProfile',
  },
};

/**
 * Full name path of a Commander command relative to the program root.
 * e.g. `validate`, `ingest openapi`, `fragment merge`.
 */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  return parts.join(' ');
}

/**
 * Apply a config's values as defaults on the given command's options.
 * Returns the names of options that were actually defaulted.
 */
function applyToCommand(cmd: Command, loaded: LoadedArchradConfig): string[] {
  const path = commandPath(cmd);
  const mapping = COMMAND_CONFIG_MAP[path];
  if (!mapping) return [];

  const applied: string[] = [];
  const opts = (cmd as unknown as { options: Option[] }).options;
  // Commander's addOption() commits defaults to option storage immediately,
  // so we have to both mutate `option.defaultValue` (for --help rendering
  // and mandatory-option satisfaction) *and* push the value into storage
  // via setOptionValueWithSource('default') so it's visible to the action.
  const setOptionValueWithSource = (
    cmd as unknown as {
      setOptionValueWithSource: (key: string, val: unknown, source: string) => void;
    }
  ).setOptionValueWithSource.bind(cmd);

  for (const [cfgKeyRaw, attrName] of Object.entries(mapping)) {
    if (!attrName) continue;
    const cfgKey = cfgKeyRaw as keyof ArchradConfig;
    const rawVal = (loaded.config as Record<string, unknown>)[cfgKey];
    if (rawVal === undefined) continue;

    const option = opts.find((o) => o.attributeName() === attrName);
    if (!option) continue;

    const coerced = coerceConfigValueForCli(cfgKey, rawVal, loaded.configDir);
    if (coerced === undefined) continue;

    option.default(coerced);
    setOptionValueWithSource(attrName, coerced, 'default');
    applied.push(attrName);
  }
  return applied;
}

/** Depth-first walk of every command and subcommand. */
function walkCommands(root: Command, visit: (cmd: Command) => void): void {
  visit(root);
  for (const child of root.commands) {
    walkCommands(child, visit);
  }
}

export interface ApplyConfigToProgramResult {
  loaded: LoadedArchradConfig | null;
  /** Map of command-path → list of option attr names that were defaulted. */
  applied: Record<string, string[]>;
}

/**
 * Pre-scan argv for the bootstrap flags that influence config discovery.
 * These are handled out-of-band so that they work on any subcommand
 * (or even before the subcommand appears).
 */
export function extractConfigBootstrapFlags(argv: string[]): {
  disabled: boolean;
  configPath: string | null;
  cleanedArgv: string[];
} {
  let disabled = false;
  let configPath: string | null = null;
  const cleaned: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-config') {
      disabled = true;
      continue;
    }
    if (a === '--config') {
      configPath = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (a.startsWith('--config=')) {
      configPath = a.slice('--config='.length);
      continue;
    }
    cleaned.push(a);
  }
  return { disabled, configPath, cleanedArgv: cleaned };
}

/**
 * Load (if any) and apply archrad.yml defaults to every subcommand of
 * `program`. Safe to call exactly once, before `program.parseAsync()`.
 */
export function applyConfigToProgram(
  program: Command,
  opts: { configPath?: string | null; disabled?: boolean; startDir?: string } = {}
): ApplyConfigToProgramResult {
  const loaded = loadArchradConfigSync({
    configPath: opts.configPath ?? undefined,
    disabled: opts.disabled,
    startDir: opts.startDir,
  });

  const applied: Record<string, string[]> = {};
  if (!loaded) return { loaded: null, applied };

  walkCommands(program, (cmd) => {
    if (cmd === program) return;
    const keys = applyToCommand(cmd, loaded);
    if (keys.length) applied[commandPath(cmd)] = keys;
  });

  return { loaded, applied };
}
