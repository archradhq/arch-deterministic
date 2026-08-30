/**
 * Types for `archrad scan` — the draft-IR orchestrator.
 *
 * `scan` runs several extractors over one repository, annotates every node/edge
 * with provenance + confidence, and merges the results into a single draft IR.
 * See docs/SPEC-scan.md.
 */

/** Confidence in an inferred node/edge, highest → lowest. */
export type Confidence = 'high' | 'medium' | 'low';

/** Numeric rank for confidence comparison (high wins). */
export function confidenceRank(c: Confidence): number {
  return c === 'high' ? 3 : c === 'medium' ? 2 : 1;
}

/** One file visible to an extractor. */
export type ScanFile = {
  /** POSIX-normalized path relative to the scan root. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
};

/** The (deterministic) view of a repository handed to each extractor. */
export type ScanFileTree = {
  /** Absolute scan root. */
  root: string;
  /** Files sorted by `relPath` for determinism. */
  files: ScanFile[];
  /** Read a file's utf8 content by relPath (cached). Returns '' if unreadable. */
  read(relPath: string): string;
};

/** A single provenance record for an inferred node or edge. */
export type Provenance = {
  /** `"<relPath>:<line>"` — line 1 when the precise line is unknown. */
  inferred_from: string;
  confidence: Confidence;
  /** Name of the extractor that produced this record. */
  extractor: string;
};

/**
 * A fragment of IR produced by one extractor invocation. Nodes/edges carry their
 * provenance under `config.provenance` (array). The `additionalProperties: true`
 * IR schema permits this.
 */
export type PartialIR = {
  extractor: string;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  warnings: string[];
};

/**
 * Extractor plugin. `extract` MUST be deterministic: no clock, no network — same
 * tree in → same fragments out. It may be async (e.g. the code extractor delegates
 * to the async reconstruct engine) and may read the filesystem under `tree.root`.
 */
export type Extractor = {
  name: string;
  /** Confidence applied to elements that do not set their own. */
  defaultConfidence: Confidence;
  extract(tree: ScanFileTree): PartialIR[] | Promise<PartialIR[]>;
};

export type ScanOptions = {
  /** Absolute or relative path to the repository root. */
  from: string;
  /** Extractor names to enable; defaults to all registered extractors. */
  extractors?: string[];
  /** Extra path fragments to exclude from the file tree (repeatable). */
  exclude?: string[];
  /**
   * File-tree scope. `all` preserves every non-build source artifact; `production`
   * also removes conventional tests, examples, docs, demos, and story files.
   * Library callers default to `all` for backwards compatibility.
   */
  scope?: 'all' | 'production';
};

export type ScanResult = {
  /** Canonical draft IR `{ graph: { metadata: { status: 'draft' }, nodes, edges } }`. */
  ir: Record<string, unknown>;
  /** Extractor names that actually ran, in canonical order. */
  extractorsRun: string[];
  warnings: string[];
  fileCount: number;
};

export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanError';
  }
}
