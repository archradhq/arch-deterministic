/**
 * PolicyPack signing — deterministic sha256 manifests with optional cosign
 * signature verification. Manifest format mirrors `sha256sum`:
 *
 *   <64-char-hex>  <filename>
 *
 * filenames are plain (no leading `./`), sorted case-sensitively, separated by
 * two spaces. One entry per line. Line endings are LF.
 *
 * When a user passes `--policies-require-signed`, every file in the directory
 * must appear in the manifest, and every entry in the manifest must hash-
 * match. Optional cosign verification (`--cosign-pubkey`) runs the `cosign`
 * binary as a subprocess on `<manifest>.sig` — we never bundle cosign.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

import type { PolicyPackFileSource } from './policy-pack.js';

/** Canonical filenames that `archrad policies-sha256` writes. */
export const POLICY_PACK_MANIFEST_NAME = 'archrad-policy-pack.sha256';
export const POLICY_PACK_SIGNATURE_NAME = `${POLICY_PACK_MANIFEST_NAME}.sig`;

/** One `<hex>  <filename>` entry parsed from a manifest. */
export type PolicyPackManifestEntry = {
  sha256: string;
  filename: string;
};

export type PolicyPackManifestVerification =
  | {
      ok: true;
      /** Files that were hash-verified. Same order as the manifest. */
      verified: string[];
    }
  | { ok: false; errors: string[] };

export type CosignVerificationResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

/** Compute the sha256 of a buffer or string as lowercase hex. */
export function sha256Hex(content: string | Uint8Array): string {
  const h = createHash('sha256');
  h.update(content);
  return h.digest('hex');
}

/**
 * Build the manifest text for a set of in-memory policy sources.
 * Filenames are sorted case-sensitively for determinism.
 */
export function buildPolicyPackManifest(sources: ReadonlyArray<PolicyPackFileSource>): string {
  const entries = [...sources]
    .map((s) => ({
      filename: basename(s.name),
      sha256: sha256Hex(s.content),
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename, 'en'));
  return `${entries.map((e) => `${e.sha256}  ${e.filename}`).join('\n')}\n`;
}

/**
 * Parse a sha256sum-style manifest. Blank lines and lines starting with `#`
 * are ignored so users can annotate manifests.
 */
export function parsePolicyPackManifest(text: string): PolicyPackManifestEntry[] {
  const entries: PolicyPackManifestEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // `sha256sum` separates with two spaces; we tolerate one or more.
    const m = /^([a-f0-9]{64})\s+(.+)$/i.exec(line);
    if (!m) {
      throw new Error(`policy-pack manifest: invalid line ${i + 1}: ${raw}`);
    }
    const filename = m[2].trim();
    if (!filename) {
      throw new Error(`policy-pack manifest: empty filename on line ${i + 1}`);
    }
    entries.push({ sha256: m[1].toLowerCase(), filename });
  }
  if (entries.length === 0) {
    throw new Error('policy-pack manifest: empty manifest (no entries)');
  }
  return entries;
}

/**
 * Verify in-memory policy sources against a manifest. Strict: every entry in
 * the manifest must exist and hash-match, and every source file must be
 * listed in the manifest. Duplicate manifest entries are rejected.
 */
export function verifyPolicyPackManifest(
  sources: ReadonlyArray<PolicyPackFileSource>,
  manifestText: string
): PolicyPackManifestVerification {
  let entries: PolicyPackManifestEntry[];
  try {
    entries = parsePolicyPackManifest(manifestText);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }

  const errors: string[] = [];
  const verified: string[] = [];
  const seenInManifest = new Set<string>();
  for (const e of entries) {
    if (seenInManifest.has(e.filename)) {
      errors.push(`policy-pack manifest: duplicate entry for "${e.filename}"`);
    }
    seenInManifest.add(e.filename);
  }

  const sourceByFilename = new Map<string, PolicyPackFileSource>();
  for (const s of sources) {
    const fn = basename(s.name);
    if (sourceByFilename.has(fn)) {
      errors.push(`policy-pack: duplicate source filename "${fn}"`);
    }
    sourceByFilename.set(fn, s);
  }

  for (const entry of entries) {
    const src = sourceByFilename.get(entry.filename);
    if (!src) {
      errors.push(
        `policy-pack manifest: "${entry.filename}" listed but missing from policies directory`
      );
      continue;
    }
    const actual = sha256Hex(src.content);
    if (actual !== entry.sha256) {
      errors.push(
        `policy-pack manifest: sha256 mismatch for "${entry.filename}" (expected ${entry.sha256}, got ${actual})`
      );
      continue;
    }
    verified.push(entry.filename);
  }

  for (const fn of sourceByFilename.keys()) {
    if (!seenInManifest.has(fn)) {
      errors.push(
        `policy-pack manifest: "${fn}" present in policies directory but missing from manifest`
      );
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, verified };
}

export type CosignVerifyOptions = {
  /** Absolute path to the manifest file being verified. */
  manifestPath: string;
  /** Absolute path to the `<manifest>.sig` signature file. */
  signaturePath: string;
  /** Absolute path to the cosign public key (PEM / `cosign.pub`). */
  publicKeyPath: string;
  /**
   * Override the `cosign` binary (default: `cosign` on PATH). Injected by
   * tests; in production the flag / env drive behaviour.
   */
  cosignBinary?: string;
};

/**
 * Verify a detached cosign signature over a blob. Uses `cosign verify-blob`
 * as a subprocess. Returns `ok: false` with a user-facing error message if
 * cosign is missing from PATH, if the signature is invalid, or if the public
 * key rejects it.
 *
 * We intentionally shell out rather than pulling the cosign library in: the
 * OSS CLI stays dependency-light, and operators almost always already have
 * cosign available in CI.
 */
export function verifyCosignSignature(opts: CosignVerifyOptions): CosignVerificationResult {
  const bin = opts.cosignBinary ?? 'cosign';
  const args = [
    'verify-blob',
    '--key',
    opts.publicKeyPath,
    '--signature',
    opts.signaturePath,
    opts.manifestPath,
  ];
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    return { ok: false, error: `cosign: failed to spawn: ${(e as Error).message}` };
  }
  if (r.error) {
    // ENOENT etc.
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        error:
          'cosign: binary not found on PATH. Install cosign (https://docs.sigstore.dev/cosign/installation) or omit --cosign-pubkey.',
      };
    }
    return { ok: false, error: `cosign: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const stderr = (r.stderr ?? '').toString().trim();
    return { ok: false, error: `cosign verify-blob failed (exit ${r.status}): ${stderr}` };
  }
  return { ok: true, stdout: (r.stdout ?? '').toString() };
}

/**
 * Convenience reader used by the CLI: returns manifest + signature metadata
 * present alongside a policies directory, or `null` for any file that is
 * absent. Caller decides how to handle "manifest missing" based on
 * require-signed mode.
 */
export async function discoverPolicyPackManifest(dir: string): Promise<{
  manifestPath: string;
  manifestText: string | null;
  signaturePath: string;
  signatureExists: boolean;
}> {
  const manifestPath = join(dir, POLICY_PACK_MANIFEST_NAME);
  const signaturePath = join(dir, POLICY_PACK_SIGNATURE_NAME);
  let manifestText: string | null = null;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw e;
  }
  let signatureExists = false;
  try {
    const s = await stat(signaturePath);
    signatureExists = s.isFile();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw e;
  }
  return { manifestPath, manifestText, signaturePath, signatureExists };
}
