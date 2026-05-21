#!/usr/bin/env node
/**
 * archrad — deterministic export without the hosted server.
 * Usage: archrad export --ir graph.json --target python --out ./my-api
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { runDeterministicExport } from './exportPipeline.js';
import { isLocalHostPortFree, normalizeGoldenHostPort } from './hostPort.js';
import { validateIrStructural, hasIrStructuralErrors, type IrStructuralFinding } from './ir-structural.js';
import { validateIrLint, type ValidateIrLintOptions } from './ir-lint.js';
import {
  loadPolicyPacksFromDirectory,
  type PolicyPackSigningOptions,
} from './policy-pack.js';
import {
  POLICY_PACK_MANIFEST_NAME,
  POLICY_PACK_SIGNATURE_NAME,
  buildPolicyPackManifest,
} from './policy-pack-sign.js';
import { readdir } from 'node:fs/promises';
import {
  findingMetrics,
  printFindingsPretty,
  shouldFailFromFindings,
  sortFindings,
  validationExitPolicyFromFailOn,
  type FailOnMode,
  type ValidationExitPolicy,
} from './cli-findings.js';
import { writeFindingsHtmlReport } from './validate-report-html.js';
import {
  parseYamlToCanonicalIr,
  canonicalIrToJsonString,
  YamlGraphParseError,
} from './yamlToIr.js';
import { openApiStringToCanonicalIr, OpenApiIngestError } from './openapi-to-ir.js';
import { runValidateDrift } from './validate-drift.js';
import {
  readOpenApiSpecInput,
  readTextFromPathOrUrl,
  isHttpOrHttpsUrl,
  parseHeaderPairs,
} from './ingest/openapi.js';
import { ingestBackstageCatalog, BackstageIngestError } from './ingest/backstage.js';
import {
  mergeIrFragments,
  FragmentMergeError,
  FragmentMergeConflictError,
} from './fragment/merge.js';
import {
  dockerComposeToCanonicalIr,
  DockerComposeInitError,
} from './init/docker-compose.js';
import { parseDotEnvText } from './init/compose-vars.js';
import {
  applyConfigToProgram,
  extractConfigBootstrapFlags,
} from './cli-config.js';
import { ArchradConfigError, describeLoadedConfig } from './config.js';
import {
  explainRuleCode,
  formatExplanationLines,
  listAllExplanations,
  normalizeRuleCode,
  suggestRuleCodes,
  type RuleLayer,
} from './explain.js';
import { readPackageVersion } from './package-version.js';
import type { ReconstructResult } from './reconstruct/types.js';

async function writeTree(baseDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(baseDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
}

/** Read and parse IR JSON; distinguish missing file from invalid JSON. */
async function readIrJsonFromPath(irPath: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(irPath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      console.error(`archrad: --ir file not found: ${irPath}`);
    } else {
      console.error(`archrad: could not read --ir file: ${irPath} (${err?.message ?? String(e)})`);
    }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error('archrad: invalid JSON in --ir file');
    return null;
  }
}

function parseMaxWarnings(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Choices for **` --ir-lint-profile **` — **` monolith-relaxed`** drops layered-microservice-centric IR-LINT rules. */
const IR_LINT_PROFILE_CHOICES = ['default', 'monolith-relaxed'] as const;

function validateIrLintOptionsFromCli(lintProfile: string | undefined): ValidateIrLintOptions {
  if (lintProfile === 'monolith-relaxed') return { lintProfile: 'monolith-relaxed' };
  return {};
}

/** Load `--policies` directory; on failure prints to stderr and returns null (caller should exit 1). */
async function loadPoliciesOption(
  policiesDir: string | undefined,
  signing?: {
    policiesRequireSigned?: boolean;
    cosignPubkey?: string;
  }
): Promise<ValidateIrLintOptions | null> {
  if (policiesDir == null || policiesDir === '') return {};
  const dir = resolve(policiesDir);
  const signingOpts: PolicyPackSigningOptions | undefined =
    signing?.policiesRequireSigned || signing?.cosignPubkey
      ? {
          requireSigned: signing.policiesRequireSigned === true,
          cosignPublicKeyPath: signing.cosignPubkey
            ? resolve(signing.cosignPubkey)
            : undefined,
        }
      : undefined;
  const loaded = await loadPolicyPacksFromDirectory(dir, signingOpts);
  if (!loaded.ok) {
    for (const e of loaded.errors) {
      console.error(`archrad: ${e}`);
    }
    return null;
  }
  if (loaded.signedBy && loaded.signedBy !== 'unsigned') {
    const mode =
      loaded.signedBy === 'cosign-verified'
        ? 'cosign + sha256'
        : 'sha256';
    console.error(`archrad: policy pack verified (${mode}) — ${loaded.ruleCount} rule(s).`);
  }
  return { policyRuleVisitors: loaded.visitors };
}

function exitPolicyFromOpts(opts: { failOnWarning?: boolean; maxWarnings?: string }): ValidationExitPolicy {
  return {
    failOnWarning: Boolean(opts.failOnWarning),
    maxWarnings: parseMaxWarnings(opts.maxWarnings),
  };
}

function validateCommandExitPolicy(opts: {
  failOn?: FailOnMode;
  failOnWarning?: boolean;
  maxWarnings?: string;
}): ValidationExitPolicy {
  if (opts.failOn !== undefined) return validationExitPolicyFromFailOn(opts.failOn);
  return exitPolicyFromOpts(opts);
}

const program = new Command();

program
  .name('archrad')
  .description(
    'Validate your architecture before you write code. Deterministic compiler + linter — FastAPI / Express (no LLM, no server).'
  )
  .version(readPackageVersion(import.meta.url));

program
  .option(
    '--config <path>',
    'Path to archrad.yml / archrad.yaml (default: walks up from CWD)'
  )
  .option('--no-config', 'Ignore any discovered archrad.yml');

program
  .command('init')
  .description('Generate IR from local artifacts (Docker Compose — zero hand-authored JSON)')
  .requiredOption(
    '-f, --from <path>',
    'Source file: docker-compose.yml, docker-compose.yaml, or compose.yml'
  )
  .option('-o, --output <path>', 'Write IR JSON (default: archrad-graph.json)')
  .option(
    '--compose-env-file <path>',
    'Dotenv fragment merged into Compose ${VAR} expansion (later files override earlier)',
    (v: string, prev: string[]) => [...prev, resolve(v)],
    [] as string[]
  )
  .option(
    '--compose-merge-process-env',
    'After --compose-env-file, merge process.env; explicit dotenv keys still win'
  )
  .option('--dry-run', 'Print IR JSON to stdout; do not write a file')
  .option('--verbose', 'Print mapping decisions to stderr')
  .action(
    async (cmdOpts: {
      from: string;
      output?: string;
      dryRun?: boolean;
      verbose?: boolean;
      composeEnvFile?: string[];
      composeMergeProcessEnv?: boolean;
    }) => {
      const fromPath = resolve(cmdOpts.from);
      let text: string;
      try {
        text = await readFile(fromPath, 'utf8');
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') {
          console.error(`archrad init: file not found at ${fromPath}`);
        } else {
          console.error(`archrad init: could not read file (${err?.message ?? String(e)})`);
        }
        process.exitCode = 1;
        return;
      }

      let interpolateFrom: Record<string, string> | undefined;
      const envPaths = cmdOpts.composeEnvFile ?? [];
      if (envPaths.length > 0) {
        interpolateFrom = {};
        for (const envPath of envPaths) {
          try {
            const blob = await readFile(envPath, 'utf8');
            Object.assign(interpolateFrom, parseDotEnvText(blob));
          } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err?.code === 'ENOENT') {
              console.error(`archrad init: --compose-env-file not found: ${envPath}`);
            } else {
              console.error(`archrad init: could not read --compose-env-file (${err?.message ?? String(e)})`);
            }
            process.exitCode = 1;
            return;
          }
        }
      }

      let ir: Record<string, unknown>;
      let report: { services: number; edges: number; warnings: string[] };
      let verboseLines: string[];
      try {
        const r = dockerComposeToCanonicalIr(text, {
          fileLabel: fromPath,
          interpolateFrom,
          interpolateFromProcessEnv: Boolean(cmdOpts.composeMergeProcessEnv),
        });
        ir = r.ir;
        report = r.report;
        verboseLines = r.verboseLines;
      } catch (e) {
        if (e instanceof DockerComposeInitError) {
          console.error(`archrad init: ${e.message}`);
        } else {
          console.error('archrad init:', e);
        }
        process.exitCode = 1;
        return;
      }

      for (const w of report.warnings) {
        console.error(`archrad init: warning: ${w}`);
      }

      if (cmdOpts.verbose) {
        console.error('archrad init: mapping:');
        for (const line of verboseLines) {
          console.error(line);
        }
        console.error(
          `archrad init: summary: ${report.services} nodes, ${report.edges} edges, ${report.warnings.length} warning(s)`
        );
      }

      const json = canonicalIrToJsonString(ir);
      if (cmdOpts.dryRun) {
        process.stdout.write(json);
        return;
      }

      const outPath = resolve(cmdOpts.output ?? 'archrad-graph.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, json, 'utf8');
      console.log(`archrad init: wrote IR JSON to ${outPath} (${report.services} nodes, ${report.edges} edges)`);
    }
  );

program
  .command('validate')
  .description(
    'Validate your architecture before you write code — IR structural (IR-STRUCT-*) + architecture lint (IR-LINT-*)'
  )
  .requiredOption('-i, --ir <path>', 'Path to IR JSON (graph with nodes/edges or full wrapper)')
  .option('--json', 'Print findings as JSON array to stdout')
  .option('--skip-lint', 'Skip architecture lint (IR-LINT-*); structural only')
  .option(
    '--policies <dir>',
    'Directory of PolicyPack YAML/JSON (*.yaml, *.yml, *.json); merged after IR-LINT-*'
  )
  .option(
    '--policies-require-signed',
    `Require a "${POLICY_PACK_MANIFEST_NAME}" manifest in --policies and verify every file against it (use \`archrad policies-sha256\` to generate)`
  )
  .option(
    '--cosign-pubkey <path>',
    `Verify "${POLICY_PACK_SIGNATURE_NAME}" against this cosign public key before checking the sha256 manifest (implies --policies-require-signed; requires cosign on PATH)`
  )
  .option('--fail-on-warning', 'Exit with error if any warning (CI gate)')
  .option(
    '--max-warnings <n>',
    'Exit with error if warning count is greater than n (e.g. 0 allows no warnings)'
  )
  .addOption(
    new Option(
      '--fail-on <mode>',
      'Exit policy: error | warning | never (GitHub Actions style; overrides --fail-on-warning when set)'
    ).choices(['error', 'warning', 'never'] as const)
  )
  .option('--report <path>', 'Write a self-contained HTML report of all findings')
  .option('--metrics-file <path>', 'Write finding counts as JSON (for CI / GitHub Actions outputs)')
  .option(
    '--findings-json-out <path>',
    'Write findings array as JSON (same shape as --json stdout); still prints pretty to stderr unless --json'
  )
  .addOption(
    new Option(
      '--ir-lint-profile <name>',
      'Built-in lint profile — monolith-relaxed omits IR-LINT-DIRECT-DB-ACCESS-002, IR-LINT-MISSING-AUTH-010, IR-LINT-MULTIPLE-HTTP-ENTRIES-009'
    ).choices([...IR_LINT_PROFILE_CHOICES])
  )
  .option(
    '--codebase <path>',
    'Path to source-code root for implementation drift analysis (IR-DRIFT-IMPL-*). Reconstructs IR from code and compares with --ir.'
  )
  .addOption(
    new Option(
      '--codebase-language <lang>',
      'Force language detection for --codebase (default: auto-detect from root markers)'
    ).choices(['auto', 'nodejs', 'python', 'csharp'])
  )
  .option(
    '--codebase-exclude <pattern>',
    'Extra path fragment to exclude from --codebase scanning (repeatable)',
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .addOption(
    new Option(
      '--impl-drift-fail-on <mode>',
      'Exit-policy threshold for IR-DRIFT-IMPL-* findings only (default: error)'
    ).choices(['error', 'warning', 'never'])
  )
  .action(
    async (cmdOpts: {
      ir: string;
      json?: boolean;
      skipLint?: boolean;
      irLintProfile?: string;
      policies?: string;
      policiesRequireSigned?: boolean;
      cosignPubkey?: string;
      failOnWarning?: boolean;
      maxWarnings?: string;
      failOn?: FailOnMode;
      report?: string;
      metricsFile?: string;
      findingsJsonOut?: string;
      codebase?: string;
      codebaseLanguage?: string;
      codebaseExclude?: string[];
      implDriftFailOn?: string;
    }) => {
      const irPath = resolve(cmdOpts.ir);
      const ir = await readIrJsonFromPath(irPath);
      if (ir == null) {
        process.exitCode = 1;
        return;
      }

      const noLint = Boolean(cmdOpts.skipLint);
      let lintOpts: ValidateIrLintOptions = validateIrLintOptionsFromCli(cmdOpts.irLintProfile);
      if (!noLint && cmdOpts.policies) {
        const loaded = await loadPoliciesOption(cmdOpts.policies, {
          policiesRequireSigned: cmdOpts.policiesRequireSigned,
          cosignPubkey: cmdOpts.cosignPubkey,
        });
        if (loaded == null) {
          process.exitCode = 1;
          return;
        }
        lintOpts = { ...lintOpts, ...loaded };
      }
      const structural = validateIrStructural(ir);
      const lint =
        noLint || hasIrStructuralErrors(structural)
          ? []
          : validateIrLint(ir, lintOpts);

      // Implementation drift — only when --codebase is supplied
      let implDrift: IrStructuralFinding[] = [];
      if (cmdOpts.codebase) {
        try {
          const { reconstructIrFromCodebase } = await import('./reconstruct/reconstruct.js');
          const { compareImplementationDrift } = await import('./ir-drift-impl.js');
          const lang = cmdOpts.codebaseLanguage;
          const reconstructed = await reconstructIrFromCodebase({
            from: resolve(cmdOpts.codebase),
            language:
              lang && lang !== 'auto'
                ? (lang as 'nodejs' | 'python' | 'csharp')
                : 'auto',
            exclude: cmdOpts.codebaseExclude,
          });
          for (const w of reconstructed.warnings) {
            console.error(`archrad: reconstruct: ${w}`);
          }
          implDrift = compareImplementationDrift(ir, reconstructed);
        } catch (e) {
          console.error(`archrad: --codebase reconstruction failed: ${e instanceof Error ? e.message : String(e)}`);
          process.exitCode = 1;
          return;
        }
      }

      const coreFindings = sortFindings([...structural, ...lint]);
      const combined = sortFindings([...coreFindings, ...implDrift]);

      if (cmdOpts.metricsFile) {
        const m = findingMetrics(combined);
        await writeFile(resolve(cmdOpts.metricsFile), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
      }
      if (cmdOpts.report) {
        await writeFindingsHtmlReport(combined, resolve(cmdOpts.report));
      }

      const forJson = combined.map((f) => ({
        ...f,
        layer:
          f.layer ??
          (f.code.startsWith('IR-LINT-')
            ? 'lint'
            : f.code.startsWith('IR-DRIFT-IMPL-')
              ? 'impl-drift'
              : 'structural'),
      }));

      if (cmdOpts.findingsJsonOut) {
        await writeFile(
          resolve(cmdOpts.findingsJsonOut),
          `${JSON.stringify(forJson, null, 2)}\n`,
          'utf8'
        );
      }

      if (cmdOpts.json) {
        console.log(JSON.stringify(forJson, null, 2));
      } else {
        if (combined.length) {
          printFindingsPretty(combined, 'archrad validate:');
        } else {
          console.log('Validate your architecture before you write code.');
          console.log('archrad: IR structural validation + architecture lint passed (no findings).');
        }
      }

      const policy = validateCommandExitPolicy(cmdOpts);
      // IR-DRIFT-IMPL-* use `--impl-drift-fail-on` only; do not fold them into the main `--fail-on` gate.
      if (shouldFailFromFindings(coreFindings, policy)) {
        process.exitCode = 1;
        return;
      }

      // Separate exit-policy gate for impl-drift findings
      if (implDrift.length > 0) {
        const driftFailOn = (cmdOpts.implDriftFailOn ?? 'error') as FailOnMode;
        const driftPolicy = validationExitPolicyFromFailOn(driftFailOn);
        if (shouldFailFromFindings(implDrift, driftPolicy)) {
          process.exitCode = 1;
        }
      }
    }
  );

program
  .command('lint')
  .description(
    'Run architecture lint only (IR-LINT-* + PolicyPacks) — fast inner-loop alternative to `archrad validate` that skips IR structural pre-checks. Same exit policy.'
  )
  .requiredOption('-i, --ir <path>', 'Path to IR JSON (graph with nodes/edges or full wrapper)')
  .option('--json', 'Print findings as JSON array to stdout')
  .option(
    '--policies <dir>',
    'Directory of PolicyPack YAML/JSON (*.yaml, *.yml, *.json); merged after IR-LINT-*'
  )
  .option(
    '--policies-require-signed',
    `Require a "${POLICY_PACK_MANIFEST_NAME}" manifest in --policies and verify every file against it`
  )
  .option(
    '--cosign-pubkey <path>',
    `Verify "${POLICY_PACK_SIGNATURE_NAME}" with this cosign public key (implies --policies-require-signed)`
  )
  .option(
    '--rule <code>',
    'Only include findings matching this rule code (repeatable; case-insensitive)',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[]
  )
  .option('--fail-on-warning', 'Exit with error if any warning (CI gate)')
  .option(
    '--max-warnings <n>',
    'Exit with error if warning count is greater than n (e.g. 0 allows no warnings)'
  )
  .addOption(
    new Option(
      '--fail-on <mode>',
      'Exit policy: error | warning | never (GitHub Actions style; overrides --fail-on-warning when set)'
    ).choices(['error', 'warning', 'never'] as const)
  )
  .option('--report <path>', 'Write a self-contained HTML report of all findings')
  .option('--metrics-file <path>', 'Write finding counts as JSON (for CI / GitHub Actions outputs)')
  .option(
    '--findings-json-out <path>',
    'Write findings array as JSON (same shape as --json stdout); still prints pretty to stderr unless --json'
  )
  .addOption(
    new Option(
      '--ir-lint-profile <name>',
      'Built-in lint profile — monolith-relaxed omits select layered-microservice IR-LINT-* rules'
    ).choices([...IR_LINT_PROFILE_CHOICES])
  )
  .action(
    async (cmdOpts: {
      ir: string;
      json?: boolean;
      irLintProfile?: string;
      policies?: string;
      policiesRequireSigned?: boolean;
      cosignPubkey?: string;
      rule?: string[];
      failOnWarning?: boolean;
      maxWarnings?: string;
      failOn?: FailOnMode;
      report?: string;
      metricsFile?: string;
      findingsJsonOut?: string;
    }) => {
      const irPath = resolve(cmdOpts.ir);
      const ir = await readIrJsonFromPath(irPath);
      if (ir == null) {
        process.exitCode = 1;
        return;
      }

      let lintOpts: ValidateIrLintOptions = validateIrLintOptionsFromCli(cmdOpts.irLintProfile);
      if (cmdOpts.policies) {
        const loaded = await loadPoliciesOption(cmdOpts.policies, {
          policiesRequireSigned: cmdOpts.policiesRequireSigned,
          cosignPubkey: cmdOpts.cosignPubkey,
        });
        if (loaded == null) {
          process.exitCode = 1;
          return;
        }
        lintOpts = { ...lintOpts, ...loaded };
      }

      // validateIrLint returns structural blockers if the IR can't be parsed;
      // otherwise IR-LINT-* + policy visitors. That's exactly the "lint-only"
      // contract we want here: no redundant structural sweep, but never a
      // silent pass on malformed IR.
      const findingsRaw = validateIrLint(ir, lintOpts);

      const ruleFilter = (cmdOpts.rule ?? [])
        .map((r) => normalizeRuleCode(r))
        .filter((r) => r.length > 0);
      const findings = ruleFilter.length
        ? findingsRaw.filter((f) => ruleFilter.includes(f.code.toUpperCase()))
        : findingsRaw;
      const combined = sortFindings(findings);

      if (cmdOpts.metricsFile) {
        const m = findingMetrics(combined);
        await writeFile(resolve(cmdOpts.metricsFile), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
      }
      if (cmdOpts.report) {
        await writeFindingsHtmlReport(combined, resolve(cmdOpts.report));
      }

      const forJson = combined.map((f) => ({
        ...f,
        layer: f.layer ?? (f.code.startsWith('IR-LINT-') ? 'lint' : 'structural'),
      }));

      if (cmdOpts.findingsJsonOut) {
        await writeFile(
          resolve(cmdOpts.findingsJsonOut),
          `${JSON.stringify(forJson, null, 2)}\n`,
          'utf8'
        );
      }

      if (cmdOpts.json) {
        console.log(JSON.stringify(forJson, null, 2));
      } else if (combined.length) {
        printFindingsPretty(combined, 'archrad lint:');
      } else if (ruleFilter.length) {
        console.log(`archrad lint: no findings match rule filter [${ruleFilter.join(', ')}].`);
      } else {
        console.log('archrad lint: architecture lint passed (no findings).');
      }

      const policy = validateCommandExitPolicy(cmdOpts);
      if (shouldFailFromFindings(combined, policy)) {
        process.exitCode = 1;
      }
    }
  );

program
  .command('explain')
  .description(
    'Show canonical guidance for a rule code (IR-STRUCT-*, IR-LINT-*, DRIFT-*). Use `archrad explain --list` to see every known code.'
  )
  .argument('[code]', 'Rule code to explain, e.g. IR-LINT-DIRECT-DB-ACCESS-002')
  .option('--json', 'Print machine-readable explanation JSON')
  .option('--list', 'List every known rule code grouped by layer')
  .action(
    (
      code: string | undefined,
      cmdOpts: { json?: boolean; list?: boolean }
    ) => {
      if (cmdOpts.list) {
        const grouped = listAllExplanations();
        if (cmdOpts.json) {
          console.log(JSON.stringify(grouped, null, 2));
          return;
        }
        const order: RuleLayer[] = ['structural', 'lint', 'drift', 'other'];
        for (const layer of order) {
          const entries = grouped[layer];
          if (!entries.length) continue;
          const heading =
            layer === 'structural'
              ? 'IR structural (IR-STRUCT-*):'
              : layer === 'lint'
                ? 'Architecture lint (IR-LINT-*):'
                : layer === 'drift'
                  ? 'Drift (DRIFT-*):'
                  : 'Other:';
          console.log(heading);
          for (const e of entries) {
            console.log(`  ${e.code} — ${e.title}`);
          }
          console.log('');
        }
        return;
      }

      if (!code) {
        console.error(
          'archrad explain: provide a rule code, e.g. `archrad explain IR-LINT-DIRECT-DB-ACCESS-002` (or run `archrad explain --list`).'
        );
        process.exitCode = 1;
        return;
      }

      const explanation = explainRuleCode(code);
      if (!explanation) {
        const normalized = normalizeRuleCode(code);
        const suggestions = suggestRuleCodes(code);
        if (cmdOpts.json) {
          console.error(
            JSON.stringify({ ok: false, code: normalized, suggestions }, null, 2)
          );
        } else {
          console.error(`archrad explain: unknown rule code "${normalized}".`);
          if (suggestions.length) {
            console.error('Did you mean:');
            for (const s of suggestions) console.error(`  ${s}`);
          } else {
            console.error('Run `archrad explain --list` to see every known rule code.');
          }
        }
        process.exitCode = 1;
        return;
      }

      if (cmdOpts.json) {
        console.log(JSON.stringify(explanation, null, 2));
        return;
      }
      for (const line of formatExplanationLines(explanation)) {
        console.log(line);
      }
    }
  );

program
  .command('policies-sha256')
  .description(
    `Generate a deterministic "${POLICY_PACK_MANIFEST_NAME}" manifest for a PolicyPack directory. Pair with \`--policies-require-signed\` (and optionally \`cosign sign-blob\` + \`--cosign-pubkey\`) to enforce signed packs in CI.`
  )
  .requiredOption('-d, --dir <dir>', 'Policies directory containing *.yaml / *.yml / *.json')
  .option(
    '-o, --out <path>',
    `Write manifest to this path (default: <dir>/${POLICY_PACK_MANIFEST_NAME}; use "-" for stdout)`
  )
  .action(async (cmdOpts: { dir: string; out?: string }) => {
    const root = resolve(cmdOpts.dir);
    let names: string[];
    try {
      names = await readdir(root);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.error(`archrad policies-sha256: cannot read ${root}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const policyFiles = names.filter((n) => /\.(yaml|yml|json)$/i.test(n)).sort();
    if (!policyFiles.length) {
      console.error(`archrad policies-sha256: no policy files (*.yaml, *.yml, *.json) in ${root}`);
      process.exitCode = 1;
      return;
    }
    const sources: { name: string; content: string }[] = [];
    for (const name of policyFiles) {
      const text = await readFile(join(root, name), 'utf8');
      sources.push({ name, content: text });
    }
    const manifest = buildPolicyPackManifest(sources);

    if (cmdOpts.out === '-') {
      process.stdout.write(manifest);
      return;
    }
    const outPath = cmdOpts.out
      ? resolve(cmdOpts.out)
      : join(root, POLICY_PACK_MANIFEST_NAME);
    await writeFile(outPath, manifest, 'utf8');
    console.log(
      `archrad policies-sha256: wrote ${policyFiles.length} entries to ${outPath}`
    );
    console.log(
      `archrad policies-sha256: optionally sign with \`cosign sign-blob --yes --output-signature ${join(
        root,
        POLICY_PACK_SIGNATURE_NAME
      )} ${outPath}\` for cosign verification.`
    );
  });

program
  .command('yaml-to-ir')
  .description(
    'Convert YAML graph → canonical IR JSON (local path, or https URL e.g. GitHub raw blueprint)'
  )
  .requiredOption(
    '-y, --yaml <path-or-url>',
    'YAML file path or https URL (`graph:` wrapper or bare `nodes:`)'
  )
  .option('-o, --out <path>', 'Write JSON to file (default: print to stdout)')
  .option(
    '-H, --header <pair>',
    'HTTP header when --yaml is a URL (repeatable). Example: -H "Authorization: Bearer <token>"',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .action(
    async (cmdOpts: { yaml: string; out?: string; header?: string[] }) => {
      let text: string;
      try {
        const headers =
          isHttpOrHttpsUrl(cmdOpts.yaml.trim()) && cmdOpts.header?.length
            ? parseHeaderPairs(cmdOpts.header)
            : undefined;
        text = await readTextFromPathOrUrl(cmdOpts.yaml, { extraHeaders: headers });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isHttpOrHttpsUrl(cmdOpts.yaml.trim())) {
          console.error(`archrad yaml-to-ir: could not fetch --yaml URL (${msg})`);
        } else {
          console.error('archrad yaml-to-ir: could not read --yaml file');
        }
        process.exitCode = 1;
        return;
      }
      let ir: Record<string, unknown>;
      try {
        ir = parseYamlToCanonicalIr(text);
      } catch (e) {
        if (e instanceof YamlGraphParseError) {
          console.error(`archrad yaml-to-ir: ${e.message}`);
        } else {
          console.error('archrad yaml-to-ir:', e);
        }
        process.exitCode = 1;
        return;
      }
      const json = canonicalIrToJsonString(ir);
      if (cmdOpts.out) {
        const outPath = resolve(cmdOpts.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, json, 'utf8');
        console.log(`archrad: wrote IR JSON to ${outPath}`);
      } else {
        process.stdout.write(json);
      }
    }
  );

const ingest = program.command('ingest').description(
  'Derive canonical IR from an external spec (structural surface — same JSON as yaml-to-ir for validate/export)'
);

ingest
  .command('openapi')
  .description('OpenAPI 3.x JSON/YAML → IR graph (HTTP nodes per operation; commit + archrad validate in CI)')
  .requiredOption(
    '-s, --spec <path-or-url>',
    'Path or https URL to OpenAPI 3.x document (.json, .yaml, or .yml)'
  )
  .option('-o, --out <path>', 'Write IR JSON to file (default: print to stdout)')
  .option(
    '-H, --header <pair>',
    'HTTP header when --spec is a URL (repeatable). Example: -H "Authorization: Bearer token"',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .action(async (cmdOpts: { spec: string; out?: string; header?: string[] }) => {
    let text: string;
    try {
      const headers =
        isHttpOrHttpsUrl(cmdOpts.spec.trim()) && cmdOpts.header?.length
          ? parseHeaderPairs(cmdOpts.header)
          : undefined;
      text = await readOpenApiSpecInput(cmdOpts.spec, headers);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isHttpOrHttpsUrl(cmdOpts.spec.trim())) {
        console.error(`archrad ingest openapi: could not fetch --spec URL (${msg})`);
      } else {
        console.error('archrad ingest openapi: could not read --spec file');
      }
      process.exitCode = 1;
      return;
    }
    let ir: Record<string, unknown>;
    try {
      ir = openApiStringToCanonicalIr(text);
    } catch (e) {
      if (e instanceof OpenApiIngestError) {
        console.error(`archrad ingest openapi: ${e.message}`);
      } else {
        console.error('archrad ingest openapi:', e);
      }
      process.exitCode = 1;
      return;
    }
    const json = canonicalIrToJsonString(ir);
    if (cmdOpts.out) {
      const outPath = resolve(cmdOpts.out);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, json, 'utf8');
      console.log(`archrad ingest openapi: wrote IR JSON to ${outPath}`);
    } else {
      process.stdout.write(json);
    }
  });

ingest
  .command('backstage')
  .description(
    'Backstage catalog-info.yaml → IR graph (Component, Resource, API, System; follows Location file targets)'
  )
  .requiredOption('-c, --catalog <dir>', 'Root directory to scan for catalog-info.yaml / Location targets')
  .option('-o, --out <path>', 'Write IR JSON to file (default: print to stdout)')
  .option('--report-json', 'Print ingest report JSON to stderr')
  .action(async (cmdOpts: { catalog: string; out?: string; reportJson?: boolean }) => {
    try {
      const { ir, report } = await ingestBackstageCatalog(cmdOpts.catalog);
      const json = canonicalIrToJsonString(ir);
      if (cmdOpts.reportJson) {
        console.error(JSON.stringify(report, null, 2));
      } else {
        console.error(
          `archrad ingest backstage: catalog files scanned: ${report.catalogFilesScanned} | locations: ${report.locationsFollowed} | entities: ${JSON.stringify(report.entitiesByKind)}`,
        );
        if (report.skipped.length) {
          console.error(`archrad ingest backstage: skipped ${report.skipped.length} (see --report-json)`);
        }
      }
      if (cmdOpts.out) {
        const outPath = resolve(cmdOpts.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, json, 'utf8');
        console.log(`archrad ingest backstage: wrote IR JSON to ${outPath}`);
      } else {
        process.stdout.write(json);
      }
    } catch (e) {
      if (e instanceof BackstageIngestError) {
        console.error(`archrad ingest backstage: ${e.message}`);
      } else {
        console.error('archrad ingest backstage:', e);
      }
      process.exitCode = 1;
    }
  });

const fragment = program.command('fragment').description('Combine IR fragments from multiple ingest sources');

fragment
  .command('merge')
  .description(
    'Merge two or more IR JSON files — by default union on node id (dedupe identical; conflicts → stderr); use --prefix-fragments for disjoint union'
  )
  .requiredOption(
    '-f, --fragments <files...>',
    'IR JSON files to merge (space-separated; at least 2)',
  )
  .option('-o, --out <path>', 'Write merged IR JSON (default: print to stdout)')
  .option(
    '--prefix-fragments',
    'Prefix each fragment’s ids (no cross-fragment id matching; legacy behavior)',
  )
  .action(async (cmdOpts: { fragments: string | string[]; out?: string; prefixFragments?: boolean }) => {
    const raw = cmdOpts.fragments;
    const files = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).filter(Boolean);
    if (files.length < 2) {
      console.error('archrad fragment merge: provide at least 2 --fragments paths');
      process.exitCode = 1;
      return;
    }
    const parsed: Record<string, unknown>[] = [];
    for (const f of files) {
      const p = resolve(f);
      const raw = await readIrJsonFromPath(p);
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        console.error(`archrad fragment merge: could not read IR: ${p}`);
        process.exitCode = 1;
        return;
      }
      parsed.push(raw as Record<string, unknown>);
    }
    try {
      const labels = files.map((f) => f.split(/[/\\]/).pop() ?? f);
      const merged = mergeIrFragments(parsed, {
        labels,
        prefixFragments: Boolean(cmdOpts.prefixFragments),
      });
      for (const w of merged.warnings) {
        console.error(w);
      }
      const json = canonicalIrToJsonString(merged.ir);
      if (cmdOpts.out) {
        const outPath = resolve(cmdOpts.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, json, 'utf8');
        console.log(`archrad fragment merge: wrote IR JSON to ${outPath}`);
      } else {
        process.stdout.write(json);
      }
    } catch (e) {
      if (e instanceof FragmentMergeConflictError) {
        for (const line of e.reportLines) {
          console.error(line);
        }
        process.exitCode = 1;
      } else if (e instanceof FragmentMergeError) {
        console.error(`archrad fragment merge: ${e.message}`);
        process.exitCode = 1;
      } else {
        console.error('archrad fragment merge:', e);
        process.exitCode = 1;
      }
    }
  });

program
  .command('export')
  .description('Generate project files from a blueprint IR JSON file')
  .requiredOption('-i, --ir <path>', 'Path to IR JSON (graph with nodes/edges or full wrapper)')
  .requiredOption('-t, --target <name>', 'python | node | nodejs')
  .requiredOption('-o, --out <dir>', 'Output directory')
  .option(
    '-p, --host-port <port>',
    'Host port for docker compose publish (container stays 8080). Env: ARCHRAD_HOST_PORT'
  )
  .option('--skip-host-port-check', 'Do not check if host port is free on 127.0.0.1')
  .option('--strict-host-port', 'Exit with error if host port is in use (implies check)')
  .addOption(
    new Option(
      '--danger-skip-ir-structural-validation',
      'UNSAFE: skip validateIrStructural (invalid IR may still export; never use in CI)'
    )
  )
  .addOption(new Option('--skip-ir-structural-validation', 'Deprecated alias').hideHelp())
  .option('--skip-ir-lint', 'Skip architecture lint (IR-LINT-*) during export')
  .option(
    '--fail-on-warning',
    'Do not write output if IR structural or lint warnings exceed policy (with --max-warnings or any warning)'
  )
  .option(
    '--max-warnings <n>',
    'With export: fail if total IR warning count > n (structural + lint warnings)'
  )
  .option(
    '--policies <dir>',
    'Directory of PolicyPack YAML/JSON (*.yaml, *.yml, *.json); merged after IR-LINT-* (skipped with --skip-ir-lint)'
  )
  .option(
    '--policies-require-signed',
    `Require a "${POLICY_PACK_MANIFEST_NAME}" manifest in --policies and verify every file against it`
  )
  .option(
    '--cosign-pubkey <path>',
    `Verify "${POLICY_PACK_SIGNATURE_NAME}" with this cosign public key (implies --policies-require-signed)`
  )
  .addOption(
    new Option(
      '--ir-lint-profile <name>',
      'Lint profile during export — monolith-relaxed omits select layered-microservice IR-LINT-* rules'
    ).choices([...IR_LINT_PROFILE_CHOICES])
  )
  .action(
    async (cmdOpts: {
      ir: string;
      target: string;
      out: string;
      hostPort?: string;
      skipHostPortCheck?: boolean;
      strictHostPort?: boolean;
      skipIrStructuralValidation?: boolean;
      skipIrLint?: boolean;
      policies?: string;
      policiesRequireSigned?: boolean;
      cosignPubkey?: string;
      failOnWarning?: boolean;
      maxWarnings?: string;
      irLintProfile?: string;
    }) => {
    const irPath = resolve(cmdOpts.ir);
    const outDir = resolve(cmdOpts.out);
    const parsed = await readIrJsonFromPath(irPath);
    if (parsed == null) {
      process.exitCode = 1;
      return;
    }
    const ir = parsed as Record<string, unknown>;
    const actualIR = ir.graph ? ir : { graph: ir };

    const hostPort = normalizeGoldenHostPort(
      cmdOpts.hostPort ?? process.env.ARCHRAD_HOST_PORT
    );

    if (!cmdOpts.skipHostPortCheck) {
      const free = await isLocalHostPortFree(hostPort);
      if (!free) {
        const msg = `archrad: host port ${hostPort} appears in use on 127.0.0.1 (docker publish may fail). Use --host-port <n>, free the port, or --skip-host-port-check.`;
        if (cmdOpts.strictHostPort) {
          console.error(msg);
          process.exitCode = 1;
          return;
        }
        console.warn(`archrad: warning: ${msg}`);
      }
    }

    const exportOpts = cmdOpts as typeof cmdOpts & {
      dangerSkipIrStructuralValidation?: boolean;
    };
    const skipStruct = Boolean(
      exportOpts.dangerSkipIrStructuralValidation || exportOpts.skipIrStructuralValidation
    );
    let exportLintOpts: ValidateIrLintOptions = validateIrLintOptionsFromCli(cmdOpts.irLintProfile);
    if (!cmdOpts.skipIrLint && cmdOpts.policies) {
      const loaded = await loadPoliciesOption(cmdOpts.policies, {
        policiesRequireSigned: cmdOpts.policiesRequireSigned,
        cosignPubkey: cmdOpts.cosignPubkey,
      });
      if (loaded == null) {
        process.exitCode = 1;
        return;
      }
      exportLintOpts = { ...exportLintOpts, ...loaded };
    }
    try {
      const { files, openApiStructuralWarnings, irStructuralFindings, irLintFindings } =
        await runDeterministicExport(actualIR, cmdOpts.target, {
          hostPort,
          skipIrStructuralValidation: skipStruct,
          skipIrLint: cmdOpts.skipIrLint,
          ...exportLintOpts,
        });

      const combined = sortFindings([...irStructuralFindings, ...irLintFindings]);
      if (combined.length) {
        printFindingsPretty(combined, 'archrad export:');
      }

      const policy = exitPolicyFromOpts(cmdOpts);
      const blockByPolicy =
        Object.keys(files).length > 0 &&
        shouldFailFromFindings(combined, policy);

      if (blockByPolicy) {
        console.error(
          'archrad: export aborted by --fail-on-warning / --max-warnings (no files written).'
        );
        process.exitCode = 1;
        return;
      }

      if (Object.keys(files).length === 0) {
        if (hasIrStructuralErrors(irStructuralFindings) && !cmdOpts.skipIrStructuralValidation) {
          console.error('archrad: export aborted due to IR structural errors (fix graph or use archrad validate).');
        } else {
          console.error('archrad: no files generated (check IR nodes/target)');
        }
        process.exitCode = 1;
        return;
      }
      await writeTree(outDir, files);
      console.log(`archrad: wrote ${Object.keys(files).length} files to ${outDir}`);
      if (openApiStructuralWarnings.length) {
        console.warn('archrad: OpenAPI document-shape warnings (parse + required fields, not Spectral lint):');
        for (const w of openApiStructuralWarnings) console.warn(`  - ${w}`);
      }
      console.log('\nNext: cd to output, then `docker compose up --build` (see README in bundle).');
    } catch (e: any) {
      console.error('archrad:', e?.message || String(e));
      process.exitCode = 1;
    }
  });

program
  .command('validate-drift')
  .description(
    'Compare on-disk export to a fresh deterministic export from IR (missing/modified files = drift; not semantic analysis)'
  )
  .requiredOption('-i, --ir <path>', 'Path to IR JSON (graph with nodes/edges or full wrapper)')
  .requiredOption('-t, --target <name>', 'python | node | nodejs')
  .requiredOption('-o, --out <dir>', 'Directory containing a previous archrad export to compare')
  .option(
    '-p, --host-port <port>',
    'Host port for golden compose (must match export). Env: ARCHRAD_HOST_PORT'
  )
  .option('--skip-host-port-check', 'Do not check if host port is free on 127.0.0.1')
  .addOption(
    new Option(
      '--danger-skip-ir-structural-validation',
      'UNSAFE: skip validateIrStructural during reference export'
    )
  )
  .addOption(new Option('--skip-ir-structural-validation', 'Deprecated alias').hideHelp())
  .option('--skip-ir-lint', 'Skip architecture lint when building reference export')
  .option(
    '--policies <dir>',
    'Directory of PolicyPack YAML/JSON; merged after IR-LINT-* for the reference export'
  )
  .option(
    '--policies-require-signed',
    `Require a "${POLICY_PACK_MANIFEST_NAME}" manifest in --policies and verify every file against it`
  )
  .option(
    '--cosign-pubkey <path>',
    `Verify "${POLICY_PACK_SIGNATURE_NAME}" with this cosign public key (implies --policies-require-signed)`
  )
  .option('--strict-extra', 'Fail if output directory contains files not in the reference export')
  .option('--json', 'Print drift findings and export metadata as JSON')
  .addOption(
    new Option(
      '--ir-lint-profile <name>',
      'Lint profile for reference export — monolith-relaxed omits select layered-microservice IR-LINT-* rules'
    ).choices([...IR_LINT_PROFILE_CHOICES])
  )
  .action(
    async (cmdOpts: {
      ir: string;
      target: string;
      out: string;
      hostPort?: string;
      skipHostPortCheck?: boolean;
      skipIrStructuralValidation?: boolean;
      dangerSkipIrStructuralValidation?: boolean;
      skipIrLint?: boolean;
      policies?: string;
      policiesRequireSigned?: boolean;
      cosignPubkey?: string;
      strictExtra?: boolean;
      json?: boolean;
      irLintProfile?: string;
    }) => {
      const irPath = resolve(cmdOpts.ir);
      const outDir = resolve(cmdOpts.out);
      const parsed = await readIrJsonFromPath(irPath);
      if (parsed == null) {
        process.exitCode = 1;
        return;
      }
      const ir = parsed as Record<string, unknown>;
      const actualIR = ir.graph ? ir : { graph: ir };

      const hostPort = normalizeGoldenHostPort(
        cmdOpts.hostPort ?? process.env.ARCHRAD_HOST_PORT
      );

      if (!cmdOpts.skipHostPortCheck) {
        const free = await isLocalHostPortFree(hostPort);
        if (!free) {
          console.warn(
            `archrad: warning: host port ${hostPort} appears in use (use --skip-host-port-check to ignore)`
          );
        }
      }

      const skipStruct = Boolean(
        cmdOpts.dangerSkipIrStructuralValidation || cmdOpts.skipIrStructuralValidation
      );

      let driftLintOpts: ValidateIrLintOptions = validateIrLintOptionsFromCli(cmdOpts.irLintProfile);
      if (!cmdOpts.skipIrLint && cmdOpts.policies) {
        const loaded = await loadPoliciesOption(cmdOpts.policies, {
          policiesRequireSigned: cmdOpts.policiesRequireSigned,
          cosignPubkey: cmdOpts.cosignPubkey,
        });
        if (loaded == null) {
          process.exitCode = 1;
          return;
        }
        driftLintOpts = { ...driftLintOpts, ...loaded };
      }

      try {
        const result = await runValidateDrift(actualIR, cmdOpts.target, outDir, {
          hostPort,
          skipIrStructuralValidation: skipStruct,
          skipIrLint: cmdOpts.skipIrLint,
          strictExtra: cmdOpts.strictExtra,
          lintProfile: driftLintOpts.lintProfile,
          policyRuleVisitors: driftLintOpts.policyRuleVisitors,
        });

        const combined = sortFindings([
          ...result.exportResult.irStructuralFindings,
          ...result.exportResult.irLintFindings,
        ]);
        if (combined.length && !cmdOpts.json) {
          printFindingsPretty(combined, 'archrad validate-drift (reference export):');
        }

        if (cmdOpts.json) {
          console.log(
            JSON.stringify(
              {
                ok: result.ok,
                driftFindings: result.driftFindings,
                extraBlocking: result.extraBlocking,
                irStructuralFindings: result.exportResult.irStructuralFindings,
                irLintFindings: result.exportResult.irLintFindings,
                openApiStructuralWarnings: result.exportResult.openApiStructuralWarnings,
                referenceFileCount: Object.keys(result.exportResult.files).length,
              },
              null,
              2
            )
          );
        } else {
          if (result.driftFindings.length) {
            console.error('archrad validate-drift:');
            for (const f of result.driftFindings) {
              const icon = f.code === 'DRIFT-EXTRA' ? 'ℹ️' : '❌';
              console.error(`${icon} ${f.code}: ${f.path}`);
              console.error(`   ${f.message}`);
              console.error('');
            }
          }
          if (result.ok) {
            console.log(
              'archrad: no deterministic drift (on-disk export matches fresh export from IR).'
            );
          } else {
            console.error(
              'archrad: drift detected — regenerate with `archrad export` or align the IR.'
            );
          }
        }

        if (!result.ok) {
          process.exitCode = 1;
        }
      } catch (e: any) {
        console.error('archrad:', e?.message || String(e));
        process.exitCode = 1;
      }
    }
  );

program
  .command('reconstruct')
  .description(
    'Reconstruct an IR graph from a real codebase and write it as JSON. ' +
    'Use with `archrad validate --codebase` to surface IR-DRIFT-IMPL-* discrepancies.'
  )
  .requiredOption('-f, --from <path>', 'Path to codebase root directory')
  .option('-o, --output <path>', 'Write reconstructed IR JSON (default: reconstructed-ir.json)')
  .addOption(
    new Option(
      '--language <lang>',
      'Force language detection (default: auto-detect from root markers)'
    ).choices(['auto', 'nodejs', 'python', 'csharp'])
  )
  .option(
    '--exclude <pattern>',
    'Extra path fragment to exclude from scanning (repeatable)',
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option('--dry-run', 'Print reconstructed IR JSON to stdout; do not write a file')
  .option('--verbose', 'Print detected artifacts to stderr')
  .action(
    async (cmdOpts: {
      from: string;
      output?: string;
      language?: string;
      exclude?: string[];
      dryRun?: boolean;
      verbose?: boolean;
    }) => {
      const lang = cmdOpts.language;
      let result: ReconstructResult;
      try {
        const { reconstructIrFromCodebase } = await import('./reconstruct/reconstruct.js');
        result = await reconstructIrFromCodebase({
          from: resolve(cmdOpts.from),
          language:
            lang && lang !== 'auto'
              ? (lang as 'nodejs' | 'python' | 'csharp')
              : 'auto',
          exclude: cmdOpts.exclude,
        });
      } catch (e) {
        console.error(`archrad reconstruct: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
        return;
      }

      for (const w of result.warnings) {
        console.error(`archrad reconstruct: warning: ${w}`);
      }

      if (cmdOpts.verbose) {
        console.error(`archrad reconstruct: language: ${result.language}`);
        console.error(`archrad reconstruct: ${result.artifacts.length} artifact(s) detected:`);
        for (const a of result.artifacts) {
          console.error(`  [${a.kind}] ${a.detail}  (${a.file})`);
        }
      }

      const json = `${JSON.stringify(result.ir, null, 2)}\n`;

      if (cmdOpts.dryRun) {
        process.stdout.write(json);
        return;
      }

      const outPath = resolve(cmdOpts.output ?? 'reconstructed-ir.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, json, 'utf8');
      const g = result.ir.graph as { nodes?: unknown[]; edges?: unknown[] };
      const nCount = Array.isArray(g?.nodes) ? g.nodes.length : 0;
      const eCount = Array.isArray(g?.edges) ? g.edges.length : 0;
      console.log(
        `archrad reconstruct: wrote ${outPath} (${nCount} node(s), ${eCount} edge(s), language: ${result.language})`
      );
    }
  );

// Resolve `--config` / `--no-config` out-of-band so the values can be
// turned into subcommand option defaults *before* Commander's mandatory-
// option check runs. The cleaned argv drops the bootstrap flags so they
// are not re-processed as unknown options on subcommands.
const bootstrap = extractConfigBootstrapFlags(process.argv.slice(2));

try {
  const result = applyConfigToProgram(program, {
    configPath: bootstrap.configPath,
    disabled: bootstrap.disabled,
  });
  const line = describeLoadedConfig(result.loaded);
  if (line) console.error(line);
} catch (e) {
  if (e instanceof ArchradConfigError) {
    console.error(`archrad: ${e.message}`);
  } else {
    console.error('archrad: could not load config:', e);
  }
  process.exit(1);
}

program.parseAsync([process.argv[0], process.argv[1], ...bootstrap.cleanedArgv]).catch((e) => {
  console.error(e);
  process.exit(1);
});
