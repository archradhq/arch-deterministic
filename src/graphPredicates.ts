/**
 * Shared graph predicates for structural validation and architecture lint (no imports from lint-graph / ir-structural).
 */

/** Node types treated as HTTP-like for path/method checks and lint (aligned structural + IR-LINT). */
export function isHttpLikeType(t: string): boolean {
  const s = String(t ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (s === 'http' || s === 'https' || s === 'rest' || s === 'api') return true;
  if (s === 'gateway' || s === 'bff' || s === 'graphql' || s === 'grpc') return true;
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
