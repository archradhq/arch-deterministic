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

async function writeTree(baseDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(baseDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
}

const program = new Command();

program
  .name('archrad')
  .description('ArchRad deterministic API export (FastAPI / Express) — no LLM, no server')
  .version('0.1.0');

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
  .action(
    async (cmdOpts: {
      ir: string;
      target: string;
      out: string;
      hostPort?: string;
      skipHostPortCheck?: boolean;
      strictHostPort?: boolean;
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
    // Accept either { graph: {...} } or raw graph
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
      const { files, openApiStructuralWarnings } = await runDeterministicExport(
        actualIR,
        cmdOpts.target,
        { hostPort }
      );
      if (Object.keys(files).length === 0) {
        console.error('archrad: no files generated (check IR nodes/target)');
        process.exitCode = 1;
        return;
      }
      await writeTree(outDir, files);
      console.log(`archrad: wrote ${Object.keys(files).length} files to ${outDir}`);
      if (openApiStructuralWarnings.length) {
        console.warn('archrad: OpenAPI structural warnings:');
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
