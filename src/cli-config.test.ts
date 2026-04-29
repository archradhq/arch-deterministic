import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command, Option } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyConfigToProgram,
  extractConfigBootstrapFlags,
} from './cli-config.js';

function makeProgram(): Command {
  const program = new Command();
  program.name('archrad');

  program
    .command('validate')
    .requiredOption('-i, --ir <path>', 'Path to IR JSON')
    .option('--skip-lint', 'Skip architecture lint')
    .option('--policies <dir>', 'Policy pack directory')
    .option('--fail-on-warning', 'Fail on warnings')
    .option('--max-warnings <n>', 'Max warnings')
    .addOption(
      new Option('--fail-on <mode>', 'Exit policy').choices([
        'error',
        'warning',
        'never',
      ] as const)
    )
    .option('--report <path>', 'HTML report path')
    .option('--metrics-file <path>', 'Metrics JSON path')
    .option('--findings-json-out <path>', 'Findings JSON path');

  program
    .command('export')
    .requiredOption('-i, --ir <path>', 'Path to IR JSON')
    .requiredOption('-t, --target <name>', 'python | node | nodejs')
    .requiredOption('-o, --out <dir>', 'Output directory')
    .option('-p, --host-port <port>', 'Host port')
    .option('--skip-host-port-check', 'Skip host-port check')
    .option('--strict-host-port', 'Strict host-port check')
    .option('--skip-ir-lint', 'Skip IR lint')
    .option('--policies <dir>', 'Policy pack directory')
    .option('--fail-on-warning', 'Fail on warnings')
    .option('--max-warnings <n>', 'Max warnings');

  program
    .command('validate-drift')
    .requiredOption('-i, --ir <path>', 'Path to IR JSON')
    .requiredOption('-t, --target <name>', 'python | node | nodejs')
    .requiredOption('-o, --out <dir>', 'Directory containing a previous export')
    .option('-p, --host-port <port>', 'Host port')
    .option('--skip-host-port-check', 'Skip host-port check')
    .option('--skip-ir-lint', 'Skip IR lint')
    .option('--policies <dir>', 'Policy pack directory')
    .option('--strict-extra', 'Fail on extra files');

  return program;
}

describe('extractConfigBootstrapFlags', () => {
  it('returns defaults when no bootstrap flags present', () => {
    const r = extractConfigBootstrapFlags(['validate', '--ir', 'g.json']);
    expect(r.disabled).toBe(false);
    expect(r.configPath).toBeNull();
    expect(r.cleanedArgv).toEqual(['validate', '--ir', 'g.json']);
  });

  it('strips --no-config', () => {
    const r = extractConfigBootstrapFlags(['--no-config', 'validate']);
    expect(r.disabled).toBe(true);
    expect(r.cleanedArgv).toEqual(['validate']);
  });

  it('strips --config <path>', () => {
    const r = extractConfigBootstrapFlags([
      '--config',
      './custom.yml',
      'export',
      '--target',
      'python',
    ]);
    expect(r.disabled).toBe(false);
    expect(r.configPath).toBe('./custom.yml');
    expect(r.cleanedArgv).toEqual(['export', '--target', 'python']);
  });

  it('strips --config=<path> (equals form)', () => {
    const r = extractConfigBootstrapFlags(['--config=./c.yml', 'validate']);
    expect(r.configPath).toBe('./c.yml');
    expect(r.cleanedArgv).toEqual(['validate']);
  });
});

describe('applyConfigToProgram', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'archrad-cli-config-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns {loaded: null} when discovery finds nothing and no path is given', () => {
    const prog = makeProgram();
    // Point startDir at a directory guaranteed to have no archrad.yml.
    const result = applyConfigToProgram(prog, { startDir: root });
    expect(result.loaded).toBeNull();
    expect(result.applied).toEqual({});
  });

  it('returns {loaded: null} when disabled', () => {
    writeFileSync(join(root, 'archrad.yml'), 'ir: ./g.json\n', 'utf8');
    const prog = makeProgram();
    const result = applyConfigToProgram(prog, { startDir: root, disabled: true });
    expect(result.loaded).toBeNull();
    expect(result.applied).toEqual({});
  });

  it('sets --ir default on validate from archrad.yml', async () => {
    writeFileSync(
      join(root, 'archrad.yml'),
      'ir: ./graph.json\nfailOn: warning\n',
      'utf8'
    );
    const prog = makeProgram();
    const result = applyConfigToProgram(prog, { startDir: root, configPath: join(root, 'archrad.yml') });
    expect(result.loaded?.config.ir).toBe('./graph.json');
    expect(result.applied.validate).toContain('ir');
    expect(result.applied.validate).toContain('failOn');

    // Simulate parse with no CLI flags: required --ir must be satisfied.
    let ranWith: any = null;
    const validate = prog.commands.find((c) => c.name() === 'validate')!;
    validate.action((opts) => {
      ranWith = opts;
    });

    // parseAsync with argv beyond [node, script]:
    await prog.parseAsync(['node', 'archrad', 'validate']);
    expect(ranWith).not.toBeNull();
    expect(ranWith.ir).toBe(resolve(root, 'graph.json'));
    expect(ranWith.failOn).toBe('warning');
  });

  it('CLI flag overrides archrad.yml default', async () => {
    writeFileSync(join(root, 'archrad.yml'), 'ir: ./from-config.json\n', 'utf8');
    const prog = makeProgram();
    applyConfigToProgram(prog, { startDir: root, configPath: join(root, 'archrad.yml') });

    let ranWith: any = null;
    const validate = prog.commands.find((c) => c.name() === 'validate')!;
    validate.action((opts) => {
      ranWith = opts;
    });

    await prog.parseAsync([
      'node',
      'archrad',
      'validate',
      '--ir',
      '/abs/from-cli.json',
    ]);
    expect(ranWith.ir).toBe('/abs/from-cli.json');
  });

  it('maps output → out for the export command', async () => {
    writeFileSync(
      join(root, 'archrad.yml'),
      ['ir: ./g.json', 'target: python', 'output: ./gen', 'hostPort: 9090'].join('\n'),
      'utf8'
    );
    const prog = makeProgram();
    const result = applyConfigToProgram(prog, {
      startDir: root,
      configPath: join(root, 'archrad.yml'),
    });
    expect(result.applied.export).toEqual(
      expect.arrayContaining(['ir', 'target', 'out', 'hostPort'])
    );

    let ranWith: any = null;
    const exportCmd = prog.commands.find((c) => c.name() === 'export')!;
    exportCmd.action((opts) => {
      ranWith = opts;
    });

    await prog.parseAsync(['node', 'archrad', 'export']);
    expect(ranWith.ir).toBe(resolve(root, 'g.json'));
    expect(ranWith.target).toBe('python');
    expect(ranWith.out).toBe(resolve(root, 'gen'));
    expect(ranWith.hostPort).toBe('9090');
  });

  it('applies drift-only keys to validate-drift', async () => {
    writeFileSync(
      join(root, 'archrad.yml'),
      [
        'ir: ./g.json',
        'target: node',
        'output: ./gen',
        'strictExtra: true',
        'skipIrLint: true',
      ].join('\n'),
      'utf8'
    );
    const prog = makeProgram();
    const result = applyConfigToProgram(prog, {
      startDir: root,
      configPath: join(root, 'archrad.yml'),
    });
    expect(result.applied['validate-drift']).toEqual(
      expect.arrayContaining(['ir', 'target', 'out', 'strictExtra', 'skipIrLint'])
    );

    let ranWith: any = null;
    const drift = prog.commands.find((c) => c.name() === 'validate-drift')!;
    drift.action((opts) => {
      ranWith = opts;
    });

    await prog.parseAsync(['node', 'archrad', 'validate-drift']);
    expect(ranWith.strictExtra).toBe(true);
    expect(ranWith.skipIrLint).toBe(true);
    expect(ranWith.target).toBe('node');
  });

  it('ignores config keys for commands that do not map them', () => {
    writeFileSync(
      join(root, 'archrad.yml'),
      // `strictExtra` is only valid for validate-drift; validate should not
      // have it set as a default.
      'strictExtra: true\n',
      'utf8'
    );
    const prog = makeProgram();
    const result = applyConfigToProgram(prog, {
      startDir: root,
      configPath: join(root, 'archrad.yml'),
    });
    expect(result.applied.validate ?? []).not.toContain('strictExtra');
  });
});
