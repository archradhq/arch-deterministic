/**
 * Shared types for source-code → IR reconstruction.
 */

export type Language = 'nodejs' | 'python' | 'csharp';

export type ArtifactKind =
  | 'http_route'
  | 'health_route'
  | 'db_connection'
  | 'auth_middleware'
  | 'service_call';

export type DetectedArtifact = {
  kind: ArtifactKind;
  /** Human-readable description: route path, DB type, middleware name, etc. */
  detail: string;
  /** Relative path from codebase root. */
  file: string;
  line?: number;
};

export type ReconstructOptions = {
  /** Absolute path to codebase root. */
  from: string;
  /** Language override; defaults to auto-detection. */
  language?: Language | 'auto';
  /** Extra path fragments to exclude (in addition to built-in exclusions). */
  exclude?: string[];
};

export type ReconstructResult = {
  /** Canonical IR graph `{ graph: { metadata, nodes, edges } }`. */
  ir: Record<string, unknown>;
  language: Language;
  /** Label for the primary service node (usually the root directory name). */
  serviceName: string;
  artifacts: DetectedArtifact[];
  warnings: string[];
};
