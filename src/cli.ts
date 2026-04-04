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
import { validateIrStructural, hasIrStructuralErrors } from './ir-structural.js';
import { validateIrLint } from './ir-lint.js';
import {
  printFindingsPretty,
  shouldFailFromFindings,
  sortFindings,
  type ValidationExitPolicy,
} from './cli-findings.js';
import {
  parseYamlToCanonicalIr,
  canonicalIrToJsonString,
  YamlGraphParseError,
} from './yamlToIr.js';
import { openApiStringToCanonicalIr, OpenApiIngestError } from './openapi-to-ir.js';
import { runValidateDrift } from './validate-drift.js';

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

function exitPolicyFromOpts(opts: { failOnWarning?: boolean; maxWarnings?: string }): ValidationExitPolicy {
  return {
    failOnWarning: Boolean(opts.failOnWarning),
    maxWarnings: parseMaxWarnings(opts.maxWarnings),
  };
}

const program = new Command();

program
  .name('archrad')
  .description(
    'Validate your architecture before you write code. Deterministic compiler + linter — FastAPI / Express (no LLM, no server).'
  )
  .version('0.1.0');

program
  .command('validate')
  .description(
    'Validate your architecture before you write code — IR structural (IR-STRUCT-*) + architecture lint (IR-LINT-*)'
  )
  .requiredOption('-i, --ir <path>', 'Path to IR JSON (graph with nodes/edges or full wrapper)')
  .option('--json', 'Print findings as JSON array to stdout')
  .option('--skip-lint', 'Skip architecture lint (IR-LINT-*); structural only')
  .option('--fail-on-warning', 'Exit with error if any warning (CI gate)')
  .option(
    '--max-warnings <n>',
    'Exit with error if warning count is greater than n (e.g. 0 allows no warnings)'
  )
  .action(
    async (cmdOpts: {
      ir: string;
      json?: boolean;
      skipLint?: boolean;
      failOnWarning?: boolean;
      maxWarnings?: string;
    }) => {
      const irPath = resolve(cmdOpts.ir);
      const ir = await readIrJsonFromPath(irPath);
      if (ir == null) {
        process.exitCode = 1;
        return;
      }

      const noLint = Boolean(cmdOpts.skipLint);
      const structural = validateIrStructural(ir);
      const lint =
        noLint || hasIrStructuralErrors(structural) ? [] : validateIrLint(ir);
      const combined = sortFindings([...structural, ...lint]);

      if (cmdOpts.json) {
        const forJson = combined.map((f) => ({
          ...f,
          layer: f.layer ?? (f.code.startsWith('IR-LINT-') ? 'lint' : 'structural'),
        }));
        console.log(JSON.stringify(forJson, null, 2));
      } else {
        if (combined.length) {
          printFindingsPretty(combined, 'archrad validate:');
        } else {
          console.log('Validate your architecture before you write code.');
          console.log('archrad: IR structural validation + architecture lint passed (no findings).');
        }
      }

      const policy = exitPolicyFromOpts(cmdOpts);
      if (shouldFailFromFindings(combined, policy)) {
        process.exitCode = 1;
      }
    }
  );

program
  .command('yaml-to-ir')
  .description('Convert YAML graph → canonical IR JSON (for validate / export without hand-editing JSON)')
  .requiredOption('-y, --yaml <path>', 'Path to YAML blueprint (`graph:` wrapper or bare `nodes:`)')
  .option('-o, --out <path>', 'Write JSON to file (default: print to stdout)')
  .action(
    async (cmdOpts: { yaml: string; out?: string }) => {
      const yamlPath = resolve(cmdOpts.yaml);
      let text: string;
      try {
        text = await readFile(yamlPath, 'utf8');
      } catch {
        console.error('archrad yaml-to-ir: could not read --yaml file');
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
  .requiredOption('-s, --spec <path>', 'Path to OpenAPI 3.x document (.json, .yaml, or .yml)')
  .option('-o, --out <path>', 'Write IR JSON to file (default: print to stdout)')
  .action(async (cmdOpts: { spec: string; out?: string }) => {
    const specPath = resolve(cmdOpts.spec);
    let text: string;
    try {
      text = await readFile(specPath, 'utf8');
    } catch {
      console.error('archrad ingest openapi: could not read --spec file');
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
      failOnWarning?: boolean;
      maxWarnings?: string;
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
    try {
      const { files, openApiStructuralWarnings, irStructuralFindings, irLintFindings } =
        await runDeterministicExport(actualIR, cmdOpts.target, {
          hostPort,
          skipIrStructuralValidation: skipStruct,
          skipIrLint: cmdOpts.skipIrLint,
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
  .option('--strict-extra', 'Fail if output directory contains files not in the reference export')
  .option('--json', 'Print drift findings and export metadata as JSON')
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
      strictExtra?: boolean;
      json?: boolean;
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

      try {
        const result = await runValidateDrift(actualIR, cmdOpts.target, outDir, {
          hostPort,
          skipIrStructuralValidation: skipStruct,
          skipIrLint: cmdOpts.skipIrLint,
          strictExtra: cmdOpts.strictExtra,
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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
