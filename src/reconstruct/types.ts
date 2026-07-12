/**
 * Shared types for source-code → IR reconstruction.
 */

export type Language = 'nodejs' | 'python' | 'csharp';

export type ArtifactKind =
  | 'http_route'
  | 'health_route'
  | 'db_connection'
  | 'auth_middleware'
  | 'service_call'
  | 'external_http'      // outbound HTTP/gRPC call with a known destination
  | 'worker_definition'  // BullMQ Worker, Agenda job, cron schedule
  | 'app_entry';         // file calls app.listen() / server.start()

export type DetectedArtifact = {
  kind: ArtifactKind;
  /** Human-readable description: route path, DB type, middleware name, etc. */
  detail: string;
  /** Relative path from codebase root. */
  file: string;
  line?: number;
  /** For external_http: normalized destination hostname or service identifier. */
  destination?: string;
  /** For db_connection: env var or variable name for this connection (used for node naming). */
  connectionName?: string;
};

export type ReconstructOptions = {
  /** Absolute path to codebase root. */
  from: string;
  /** Language override; defaults to auto-detection. */
  language?: Language | 'auto';
  /** Extra path fragments to exclude (in addition to built-in exclusions). */
  exclude?: string[];
  /**
   * When true, collapse everything into a single service node instead of
   * decomposing route/controller files into separate service nodes. Used by
   * `archrad scan`, where a monolith's many route modules should read as one
   * service, not many. Default false (decomposition preserved).
   */
  singleService?: boolean;
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
