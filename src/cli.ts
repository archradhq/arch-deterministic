#!/usr/bin/env node
/**
 * archrad — deterministic export without the hosted server.
 * Usage: archrad export --ir graph.json --target python --out ./my-api
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
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

async function writeTree(baseDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(baseDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf8');
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
    'Deterministic architecture compiler & linter — FastAPI / Express export (no LLM, no server)'
  )
  .version('0.1.0');

program
  .command('validate')
  .description('IR structural validation + architecture lint (no code generation)')
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
      let ir: unknown;
      try {
        ir = JSON.parse(await readFile(irPath, 'utf8'));
      } catch {
        console.error('archrad: invalid JSON in --ir file');
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
  .option(
    '--skip-ir-structural-validation',
    'Skip IR structural checks (not recommended; for debugging only)'
  )
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
    const raw = await readFile(irPath, 'utf8');
    let ir: any;
    try {
      ir = JSON.parse(raw);
    } catch {
      console.error('archrad: invalid JSON in --ir file');
      process.exitCode = 1;
      return;
    }
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

    try {
      const { files, openApiStructuralWarnings, irStructuralFindings, irLintFindings } =
        await runDeterministicExport(actualIR, cmdOpts.target, {
          hostPort,
          skipIrStructuralValidation: cmdOpts.skipIrStructuralValidation,
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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
