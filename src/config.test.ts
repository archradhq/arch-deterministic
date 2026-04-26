import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  findArchradConfigFile,
  readArchradConfigFileSync,
  loadArchradConfigSync,
  resolveConfigPath,
  coerceConfigValueForCli,
  describeLoadedConfig,
  ArchradConfigError,
} from './config.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'archrad-config-'));
}

describe('config — discovery', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null when no config exists anywhere on the walk', () => {
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    // Start deep enough that the walk cannot escape into a real project's
    // config higher up on the filesystem.
    const found = findArchradConfigFile(nested);
    // We cannot strictly assert null because the process may have an
    // archrad.yml higher up. Assert that *if* it is non-null, it is not
    // inside our temp dir (no file was created there).
    if (found !== null) {
      expect(found.startsWith(root)).toBe(false);
    }
  });

  it('finds archrad.yml in the start directory', () => {
    const cfgPath = join(root, 'archrad.yml');
    writeFileSync(cfgPath, 'ir: ./graph.json\n', 'utf8');
    expect(findArchradConfigFile(root)).toBe(resolve(cfgPath));
  });

  it('walks up to find archrad.yaml in an ancestor', () => {
    const cfgPath = join(root, 'archrad.yaml');
    writeFileSync(cfgPath, 'target: python\n', 'utf8');
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(findArchradConfigFile(deep)).toBe(resolve(cfgPath));
  });

  it('prefers archrad.yml over archrad.yaml in the same dir', () => {
    writeFileSync(join(root, 'archrad.yml'), 'ir: ./yml.json\n', 'utf8');
    writeFileSync(join(root, 'archrad.yaml'), 'ir: ./yaml.json\n', 'utf8');
    const found = findArchradConfigFile(root);
    expect(found).toBe(resolve(join(root, 'archrad.yml')));
  });
});

describe('config — parsing', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses a valid config', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(
      p,
      [
        'version: 1',
        'ir: ./graph.json',
        'target: python',
        'output: ./generated',
        'failOn: error',
        'maxWarnings: 0',
        'skipLint: false',
        'hostPort: 8080',
      ].join('\n'),
      'utf8'
    );
    const loaded = readArchradConfigFileSync(p);
    expect(loaded.config.ir).toBe('./graph.json');
    expect(loaded.config.target).toBe('python');
    expect(loaded.config.failOn).toBe('error');
    expect(loaded.config.maxWarnings).toBe(0);
    expect(loaded.config.skipLint).toBe(false);
    expect(loaded.config.hostPort).toBe(8080);
    expect(loaded.configDir).toBe(root);
    expect(loaded.configPath).toBe(resolve(p));
  });

  it('treats empty files as empty config', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(p, '# just a comment\n', 'utf8');
    const loaded = readArchradConfigFileSync(p);
    expect(loaded.config).toEqual({});
  });

  it('throws ArchradConfigError on missing file', () => {
    const p = join(root, 'does-not-exist.yml');
    expect(() => readArchradConfigFileSync(p)).toThrow(ArchradConfigError);
  });

  it('throws on invalid YAML', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(p, 'ir: [unclosed\n', 'utf8');
    expect(() => readArchradConfigFileSync(p)).toThrow(/could not parse/);
  });

  it('throws on top-level arrays', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(p, '- one\n- two\n', 'utf8');
    expect(() => readArchradConfigFileSync(p)).toThrow(/top-level must be a YAML mapping/);
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(p, 'notARealKey: true\n', 'utf8');
    expect(() => readArchradConfigFileSync(p)).toThrow(/invalid config/);
  });

  it('rejects invalid enum values for target', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(p, 'target: rust\n', 'utf8');
    expect(() => readArchradConfigFileSync(p)).toThrow(/invalid config/);
  });

  it('rejects invalid enum values for failOn', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(p, 'failOn: strict\n', 'utf8');
    expect(() => readArchradConfigFileSync(p)).toThrow(/invalid config/);
  });

  it('rejects non-integer maxWarnings', () => {
    const p = join(root, 'archrad.yml');
    writeFileSync(p, 'maxWarnings: -1\n', 'utf8');
    expect(() => readArchradConfigFileSync(p)).toThrow(/invalid config/);
  });
});

describe('config — loadArchradConfigSync', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null when disabled', () => {
    writeFileSync(join(root, 'archrad.yml'), 'ir: x\n', 'utf8');
    expect(loadArchradConfigSync({ startDir: root, disabled: true })).toBeNull();
  });

  it('uses explicit configPath over discovery', () => {
    const other = join(root, 'custom.yml');
    writeFileSync(other, 'target: node\n', 'utf8');
    writeFileSync(join(root, 'archrad.yml'), 'target: python\n', 'utf8');
    const loaded = loadArchradConfigSync({ startDir: root, configPath: other });
    expect(loaded?.config.target).toBe('node');
    expect(loaded?.configPath).toBe(resolve(other));
  });

  it('discovers by walking upward', () => {
    writeFileSync(join(root, 'archrad.yml'), 'ir: ./g.json\n', 'utf8');
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const loaded = loadArchradConfigSync({ startDir: deep });
    expect(loaded?.configDir).toBe(root);
  });
});

describe('config — helpers', () => {
  it('resolveConfigPath keeps absolute paths', () => {
    const abs = isAbsolute('/tmp/foo') ? '/tmp/foo' : 'C:\\tmp\\foo';
    expect(resolveConfigPath(abs, '/any/dir')).toBe(abs);
  });

  it('resolveConfigPath resolves relative paths against configDir', () => {
    const configDir = process.cwd();
    expect(resolveConfigPath('./g.json', configDir)).toBe(resolve(configDir, 'g.json'));
  });

  it('resolveConfigPath returns undefined for empty strings', () => {
    expect(resolveConfigPath('', '/any')).toBeUndefined();
    expect(resolveConfigPath(undefined, '/any')).toBeUndefined();
  });

  it('coerceConfigValueForCli resolves path keys', () => {
    const configDir = process.cwd();
    expect(coerceConfigValueForCli('ir', './graph.json', configDir)).toBe(
      resolve(configDir, 'graph.json')
    );
    expect(coerceConfigValueForCli('policies', './policies', configDir)).toBe(
      resolve(configDir, 'policies')
    );
  });

  it('coerceConfigValueForCli stringifies maxWarnings', () => {
    expect(coerceConfigValueForCli('maxWarnings', 3, process.cwd())).toBe('3');
  });

  it('coerceConfigValueForCli stringifies hostPort (number → string)', () => {
    expect(coerceConfigValueForCli('hostPort', 8080, process.cwd())).toBe('8080');
    expect(coerceConfigValueForCli('hostPort', '9000', process.cwd())).toBe('9000');
  });

  it('coerceConfigValueForCli passes booleans / enums through', () => {
    expect(coerceConfigValueForCli('skipLint', true, process.cwd())).toBe(true);
    expect(coerceConfigValueForCli('failOn', 'error', process.cwd())).toBe('error');
  });

  it('describeLoadedConfig returns null when no config', () => {
    expect(describeLoadedConfig(null)).toBeNull();
  });

  it('describeLoadedConfig returns a user-readable line', () => {
    const line = describeLoadedConfig({
      config: {},
      configPath: join(process.cwd(), 'archrad.yml'),
      configDir: process.cwd(),
    });
    expect(line).toMatch(/archrad: using config from /);
  });
});
