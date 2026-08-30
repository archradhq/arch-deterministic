/**
 * Release gate: verify the PUBLISHED SURFACE, not the source tree.
 *
 * Why this exists
 * ---------------
 * 0.7.0 shipped twice-broken documentation while every one of 583 unit tests
 * passed. Both defects were the same shape: the artifact worked, the documented
 * path did not.
 *
 *   0.6.x  README said `archrad validate --ir fixtures/demo-...json`
 *          -> resolves only in a git clone; after `npm i -g` there is no
 *             fixtures/ dir in the caller's CWD.
 *   0.7.0  README said `npx @archrad/deterministic demo`
 *          -> `npx <pkg>` runs a bin whose NAME MATCHES THE PACKAGE NAME. This
 *             package ships `archrad` + `archrad-mcp`, so npx cannot choose and
 *             fails with "could not determine executable to run".
 *
 * The unit suite structurally cannot catch either: it tests `src/` and
 * `dist/cli.js` in place. This script installs the real packed tarball into a
 * throwaway project and runs the commands the README literally tells users to
 * run. Commands are EXTRACTED from the README rather than hardcoded here, so the
 * gate cannot drift away from the docs.
 *
 * Usage:  npm run verify:surface        (also wired into prepublishOnly)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const PKG_NAME = pkg.name;
const BIN_NAMES = Object.keys(pkg.bin ?? {});

/** Subcommands that are fast, read-only, and need no files in the CWD. */
const RUNNABLE = new Set(['demo', 'explain', '--help', '--version', '-h', '-V']);

/**
 * Run npm without a shell.
 *
 * `shell: true` concatenates rather than escapes arguments (Node DEP0190), and
 * some of these arguments come from README text — not a combination worth
 * shipping. But Node >= 20 also refuses to spawn Windows `.cmd` shims without a
 * shell (the CVE-2024-27980 mitigation), so `npm.cmd` is not an option either.
 *
 * `npm_execpath` is set by npm for any script it runs and points at
 * `npm-cli.js`, so we can drive npm through the current Node binary and avoid
 * shells on every platform. The `.cmd` path stays only as a last resort for
 * direct `node scripts/...` invocation outside npm.
 */
const NPM_JS = process.env.npm_execpath;
function npmRun(args, cwd) {
  if (NPM_JS?.endsWith('.js')) {
    return spawnSync(process.execPath, [NPM_JS, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

const failures = [];
const notes = [];
function fail(msg) {
  failures.push(msg);
  console.error(`  FAIL  ${msg}`);
}
function pass(msg) {
  console.log(`  ok    ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. Static lint: `npx <pkg> <subcommand>` can never work unless a bin is named
//    after the package's last path segment. Catches the 0.7.0 defect without
//    installing anything.
// ---------------------------------------------------------------------------
function lintNpxUsage() {
  console.log('\n[1/3] README/doc lint — npx invocations');
  const shortName = PKG_NAME.split('/').pop();
  const npxBinWorks = BIN_NAMES.includes(shortName) || BIN_NAMES.includes(PKG_NAME);

  const docFiles = [
    join(root, 'README.md'),
    ...readdirSync(join(root, 'docs'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(root, 'docs', e.name)),
  ];

  // `npx @scope/pkg <word>` where <word> is not a flag-less bin name.
  const bare = new RegExp(`npx\\s+(?:--yes\\s+|-y\\s+)?${PKG_NAME.replace('/', '\\/')}\\s+([a-z][\\w-]*)`, 'g');
  let found = 0;
  for (const file of docFiles) {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const m of text.matchAll(bare)) {
      // `npx <pkg> <sub>` only resolves if a bin is named after the package.
      if (npxBinWorks) continue;
      found += 1;
      fail(
        `${file.replace(root, '.')}: "npx ${PKG_NAME} ${m[1]}" cannot work — ` +
          `no bin named "${shortName}" (bins: ${BIN_NAMES.join(', ')}). ` +
          `Use "npx --package=${PKG_NAME} ${BIN_NAMES[0]} ${m[1]}" or document a global install.`
      );
    }
  }
  if (found === 0) pass(`no unresolvable "npx ${PKG_NAME} <cmd>" invocations in ${docFiles.length} doc file(s)`);
}

// ---------------------------------------------------------------------------
// 2. Extract the commands the README actually tells people to run.
// ---------------------------------------------------------------------------
function extractReadmeCommands() {
  // Normalize CRLF: a Windows checkout stores "```bash\r\n", and a regex
  // expecting "\n" straight after the language tag silently matches nothing —
  // which would make this gate quietly pass by finding zero commands.
  const text = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const cmds = [];
  for (const block of text.matchAll(/```(?:bash|sh|shell|console)\n([\s\S]*?)```/g)) {
    for (const raw of block[1].split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      for (const bin of BIN_NAMES) {
        if (line === bin || line.startsWith(`${bin} `)) {
          const args = line.slice(bin.length).trim().split(/\s+/).filter(Boolean);
          cmds.push({ bin, args, source: line });
        }
      }
    }
  }
  return cmds;
}

// ---------------------------------------------------------------------------
// 3. Install the real tarball into a throwaway project and run them.
// ---------------------------------------------------------------------------
function verifyAgainstTarball() {
  console.log('\n[2/3] pack + install the real tarball');
  const packed = npmRun(['pack', '--silent', '--pack-destination', root], root);
  if (packed.status !== 0) {
    fail(
      `npm pack failed (exit ${packed.status}${packed.error ? `, ${packed.error.message}` : ''}): ` +
        `${(packed.stderr || packed.stdout || '(no output)').trim().slice(0, 400)}`
    );
    return;
  }
  const tgzName = (packed.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!tgzName) {
    fail('npm pack produced no tarball name');
    return;
  }
  const tgz = join(root, tgzName);
  pass(`packed ${tgzName}`);

  const proj = mkdtempSync(join(tmpdir(), 'archrad-surface-'));
  try {
    writeFileSync(
      join(proj, 'package.json'),
      JSON.stringify({ name: 'surface-check', version: '1.0.0', private: true }, null, 2)
    );
    const install = npmRun(['install', '--silent', '--no-audit', '--no-fund', tgz], proj);
    if (install.status !== 0) {
      fail(`installing the tarball failed: ${(install.stderr || '').trim().slice(0, 400)}`);
      return;
    }
    pass('installed into a throwaway project (no global side effects)');

    // Every declared bin must resolve through npm's own bin linking.
    console.log('\n[3/3] run the documented commands');
    for (const bin of BIN_NAMES) {
      const r = npmRun(['exec', '--no', '--', bin, '--version'], proj);
      if (r.status !== 0) {
        fail(`bin "${bin}" does not resolve after install: ${(r.stderr || '').trim().slice(0, 300)}`);
      } else {
        pass(`bin "${bin}" resolves (${(r.stdout || '').trim().split('\n').pop()})`);
      }
    }

    const cmds = extractReadmeCommands();
    if (cmds.length === 0) {
      fail('no runnable commands found in README code blocks — the quick start may have been removed');
      return;
    }

    let ran = 0;
    for (const { bin, args, source } of cmds) {
      const head = args[0] ?? '--help';
      if (!RUNNABLE.has(head)) {
        notes.push(`skipped (needs a real project): ${source}`);
        continue;
      }
      const r = npmRun(['exec', '--no', '--', bin, ...args], proj);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status !== 0) {
        fail(`README command failed (exit ${r.status}): ${source}\n        ${out.trim().split('\n')[0] ?? ''}`);
      } else if (/could not determine executable|file not found|command not found/i.test(out)) {
        fail(`README command exited 0 but reports a resolution error: ${source}`);
      } else {
        pass(`README command works: ${source}`);
      }
      ran += 1;
    }
    if (ran === 0) fail('README contains no directly runnable command — a new user has nothing that works');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(tgz, { force: true });
  }
}

console.log(`Verifying published surface of ${PKG_NAME}@${pkg.version}`);
lintNpxUsage();
verifyAgainstTarball();

if (notes.length) {
  console.log('\nSkipped (not runnable in an empty project):');
  for (const n of notes) console.log(`  -     ${n}`);
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s) with the published surface. Not safe to publish.`);
  process.exit(1);
}
console.log('\nPublished surface OK — the documented path works from a real install.');
