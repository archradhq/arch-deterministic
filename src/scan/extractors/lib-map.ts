/**
 * Hand-maintained client-library → infrastructure-node lookup for the manifest
 * extractor. No runtime dependency, fully deterministic (ArchRAD core principle).
 *
 * Only *driver-level* libraries that imply a concrete infra edge are listed —
 * ORMs and generic HTTP clients (axios, requests) are intentionally omitted
 * because they do not name a specific backend.
 *
 * Infra `type` + `name` are chosen so `scanNodeId(type, name)` produces the SAME
 * id the compose extractor produces for the same component (e.g. a Postgres db is
 * `"postgres"`, a Redis cache is `"cache_redis"`) — that id agreement is what lets
 * the merger recognize when compose and a manifest describe the same datastore.
 */

export type InfraTarget = {
  /** IR node type (also the `kind` fed to scanNodeId). */
  type: string;
  /** Canonical node name (fed to scanNodeId). */
  name: string;
  /** Edge relation label. */
  relation: string;
  protocol: string;
  async: boolean;
};

const DB = (type: string, name: string): InfraTarget => ({
  type,
  name,
  relation: 'dbConnection',
  protocol: 'tcp',
  async: false,
});
const CACHE: InfraTarget = { type: 'cache', name: 'redis', relation: 'cacheConnection', protocol: 'tcp', async: false };
const QUEUE = (name: string): InfraTarget => ({ type: 'queue', name, relation: 'queue', protocol: 'tcp', async: true });

/** npm package (from package.json `dependencies`) → infra target. */
export const NPM_LIB_MAP: Record<string, InfraTarget> = {
  pg: DB('postgres', 'postgres'),
  postgres: DB('postgres', 'postgres'),
  'pg-promise': DB('postgres', 'postgres'),
  mysql: DB('mysql', 'mysql'),
  mysql2: DB('mysql', 'mysql'),
  mongodb: DB('mongodb', 'mongodb'),
  mongoose: DB('mongodb', 'mongodb'),
  'cassandra-driver': DB('cassandra', 'cassandra'),
  '@elastic/elasticsearch': DB('search', 'elasticsearch'),
  elasticsearch: DB('search', 'elasticsearch'),
  redis: CACHE,
  ioredis: CACHE,
  bullmq: CACHE,
  bull: CACHE,
  amqplib: QUEUE('rabbitmq'),
  kafkajs: QUEUE('kafka'),
  nodemailer: { type: 'smtp', name: 'smtp', relation: 'smtp', protocol: 'smtp', async: false },
  'firebase-admin': DB('firestore', 'firestore'),
  stripe: { type: 'service', name: 'stripe', relation: 'serviceCall', protocol: 'https', async: false },
};

/** PyPI package (from requirements.txt) → infra target. */
export const PIP_LIB_MAP: Record<string, InfraTarget> = {
  psycopg2: DB('postgres', 'postgres'),
  'psycopg2-binary': DB('postgres', 'postgres'),
  asyncpg: DB('postgres', 'postgres'),
  pymysql: DB('mysql', 'mysql'),
  mysqlclient: DB('mysql', 'mysql'),
  pymongo: DB('mongodb', 'mongodb'),
  motor: DB('mongodb', 'mongodb'),
  'cassandra-driver': DB('cassandra', 'cassandra'),
  elasticsearch: DB('search', 'elasticsearch'),
  redis: CACHE,
  aioredis: CACHE,
  pika: QUEUE('rabbitmq'),
  'kafka-python': QUEUE('kafka'),
  'confluent-kafka': QUEUE('kafka'),
};

/**
 * Go module path (from go.mod `require`) → infra target. Keyed on the module
 * path with any trailing `/vN` major-version suffix already stripped by the
 * caller (`github.com/jackc/pgx/v5` is looked up as `github.com/jackc/pgx`).
 */
export const GO_LIB_MAP: Record<string, InfraTarget> = {
  'github.com/lib/pq': DB('postgres', 'postgres'),
  'github.com/jackc/pgx': DB('postgres', 'postgres'),
  'github.com/go-sql-driver/mysql': DB('mysql', 'mysql'),
  'go.mongodb.org/mongo-driver': DB('mongodb', 'mongodb'),
  'github.com/gocql/gocql': DB('cassandra', 'cassandra'),
  'cloud.google.com/go/firestore': DB('firestore', 'firestore'),
  'github.com/redis/go-redis': CACHE,
  'github.com/go-redis/redis': CACHE,
  'github.com/gomodule/redigo': CACHE,
  'github.com/streadway/amqp': QUEUE('rabbitmq'),
  'github.com/rabbitmq/amqp091-go': QUEUE('rabbitmq'),
  'github.com/segmentio/kafka-go': QUEUE('kafka'),
  'github.com/confluentinc/confluent-kafka-go': QUEUE('kafka'),
  'github.com/elastic/go-elasticsearch': DB('search', 'elasticsearch'),
};

/** Maven `groupId:artifactId` (from pom.xml `<dependency>`) → infra target. */
export const MAVEN_LIB_MAP: Record<string, InfraTarget> = {
  'org.postgresql:postgresql': DB('postgres', 'postgres'),
  'mysql:mysql-connector-java': DB('mysql', 'mysql'),
  'com.mysql:mysql-connector-j': DB('mysql', 'mysql'),
  'org.mongodb:mongodb-driver-sync': DB('mongodb', 'mongodb'),
  'org.mongodb:mongo-java-driver': DB('mongodb', 'mongodb'),
  'com.datastax.oss:java-driver-core': DB('cassandra', 'cassandra'),
  'com.google.cloud:google-cloud-firestore': DB('firestore', 'firestore'),
  'redis.clients:jedis': CACHE,
  'io.lettuce:lettuce-core': CACHE,
  'com.rabbitmq:amqp-client': QUEUE('rabbitmq'),
  'org.springframework.amqp:spring-rabbit': QUEUE('rabbitmq'),
  'org.apache.kafka:kafka-clients': QUEUE('kafka'),
  'org.springframework.kafka:spring-kafka': QUEUE('kafka'),
  'org.elasticsearch.client:elasticsearch-rest-high-level-client': DB('search', 'elasticsearch'),
  'jakarta.mail:jakarta.mail-api': { type: 'smtp', name: 'smtp', relation: 'smtp', protocol: 'smtp', async: false },
  'com.sun.mail:javax.mail': { type: 'smtp', name: 'smtp', relation: 'smtp', protocol: 'smtp', async: false },
};
