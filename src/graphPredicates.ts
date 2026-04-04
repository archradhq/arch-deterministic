/**
 * Shared graph predicates for structural validation and architecture lint (no imports from lint-graph / ir-structural).
 */

/**
 * Narrow predicate: node types that carry a single HTTP endpoint (`config.url` + HTTP method).
 * Used by **structural validation** for `IR-STRUCT-HTTP_PATH` / `IR-STRUCT-HTTP_METHOD` checks.
 * **`http` / `https` / `rest` / `api` / `graphql`** share this contract in the IR (GraphQL is one route + method in the IR model).
 * **`gateway`**, **`grpc`**, and **`bff`** are intentionally **excluded** — they use different config shapes
 * (upstream routing, proto service/method, multi-route aggregation) and must not be required
 * to supply a REST-style `url` + HTTP method; they remain **`isHttpLikeType`** for lint (entries, health, sync chain, etc.).
 */
export function isHttpEndpointType(t: string): boolean {
  const s = String(t ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  return s === 'http' || s === 'https' || s === 'rest' || s === 'api' || s === 'graphql';
}

/**
 * Broad predicate: all HTTP-like node types for lint purposes (healthcheck detection,
 * sync-chain analysis, missing-name checks, multiple-entry detection).
 * Superset of `isHttpEndpointType`.
 */
export function isHttpLikeType(t: string): boolean {
  const s = String(t ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (isHttpEndpointType(s)) return true;
  if (s === 'gateway' || s === 'bff' || s === 'grpc') return true;
  return /\b(api|gateway|bff|graphql|grpc)\b/.test(s);
}

/** Datastore-like (unchanged semantics; kept adjacent for docs). */
export function isDbLikeType(t: string): boolean {
  if (!t) return false;
  return (
    /\b(db|database|datastore)\b/.test(t) ||
    /postgres|mongodb|mysql|sqlite|redis|cassandra|dynamo|sql|nosql|warehouse|s3/.test(t)
  );
}

/**
 * Auth-like node types: dedicated identity/auth/middleware nodes.
 * Used by IR-LINT-MISSING-AUTH-010 to detect HTTP entry nodes with no auth coverage.
 */
export function isAuthLikeNodeType(t: string): boolean {
  const s = String(t ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  return (
    /\b(auth|authentication|authorization|middleware|security|iam|idp|identity)\b/.test(s) ||
    /oauth|jwt|saml|keycloak|okta|cognito|auth0|ldap|sso/.test(s)
  );
}

/** Queue / topic / stream node types → treat incoming edges as async boundaries when edge metadata is absent. */
export function isQueueLikeNodeType(t: string): boolean {
  const s = String(t ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  return (
    /\b(queue|topic|stream|pubsub|event|bus)\b/.test(s) ||
    /kafka|sns|sqs|amqp|mqtt|nats|rabbitmq|pulsar/.test(s)
  );
}
