/**
 * Hand-maintained Terraform `resource` type → infra-node lookup for the
 * terraform extractor. Same shape and rationale as `lib-map.ts`: no runtime
 * dependency, fully deterministic. Covers the common AWS/GCP/Azure resource
 * types that imply a concrete infra component; generic/plumbing resources
 * (IAM roles, security groups, VPCs, subnets) are intentionally omitted —
 * they don't name a component worth a node.
 */

export type TerraformInfraTarget = {
  /** IR node type (also the `kind` fed to scanNodeId). */
  type: string;
};

const DB = (type: string): TerraformInfraTarget => ({ type });

/** Terraform `resource` type → infra target. */
export const TERRAFORM_RESOURCE_MAP: Record<string, TerraformInfraTarget> = {
  // ---- AWS ----
  aws_db_instance: DB('postgres'), // engine varies (postgres/mysql/mariadb/…); see refineAwsDbEngine()
  aws_rds_cluster: DB('postgres'),
  aws_dynamodb_table: DB('dynamodb'),
  aws_elasticache_cluster: DB('cache'),
  aws_elasticache_replication_group: DB('cache'),
  aws_docdb_cluster: DB('mongodb'),
  aws_sqs_queue: DB('queue'),
  aws_sns_topic: DB('queue'),
  aws_mq_broker: DB('queue'),
  aws_s3_bucket: DB('storage'),
  aws_ecs_service: DB('service'),
  aws_lambda_function: DB('service'),
  aws_apprunner_service: DB('service'),
  aws_elastic_beanstalk_environment: DB('service'),
  aws_lb: DB('gateway'),
  aws_apigatewayv2_api: DB('gateway'),
  aws_api_gateway_rest_api: DB('gateway'),
  aws_ses_domain_identity: DB('smtp'),

  // ---- GCP ----
  google_sql_database_instance: DB('postgres'), // engine varies; see refineGoogleSqlEngine()
  google_firestore_database: DB('firestore'),
  google_redis_instance: DB('cache'),
  google_pubsub_topic: DB('queue'),
  google_storage_bucket: DB('storage'),
  google_cloud_run_service: DB('service'),
  google_cloud_run_v2_service: DB('service'),
  google_app_engine_application: DB('service'),
  google_compute_instance: DB('service'),
  google_api_gateway_api: DB('gateway'),
  google_compute_global_forwarding_rule: DB('gateway'),

  // ---- Azure ----
  azurerm_postgresql_server: DB('postgres'),
  azurerm_postgresql_flexible_server: DB('postgres'),
  azurerm_mysql_server: DB('mysql'),
  azurerm_mysql_flexible_server: DB('mysql'),
  azurerm_cosmosdb_account: DB('mongodb'),
  azurerm_redis_cache: DB('cache'),
  azurerm_servicebus_namespace: DB('queue'),
  azurerm_storage_account: DB('storage'),
  azurerm_container_group: DB('service'),
  azurerm_app_service: DB('service'),
  azurerm_linux_web_app: DB('service'),
  azurerm_function_app: DB('service'),
  azurerm_application_gateway: DB('gateway'),
};

/** `aws_db_instance`'s actual type depends on its `engine = "..."` argument. */
export function refineAwsDbEngine(engine: string | undefined): string {
  const e = (engine ?? '').toLowerCase();
  if (e.includes('mysql') || e.includes('maria')) return 'mysql';
  if (e.includes('postgres')) return 'postgres';
  if (e.includes('oracle') || e.includes('sqlserver')) return 'sqlserver';
  return 'postgres'; // default bucket, matches dbNodeType()'s own fallback
}

/** `google_sql_database_instance`'s type depends on its `database_version = "..."` argument. */
export function refineGoogleSqlEngine(databaseVersion: string | undefined): string {
  const v = (databaseVersion ?? '').toUpperCase();
  if (v.startsWith('MYSQL')) return 'mysql';
  if (v.startsWith('SQLSERVER')) return 'sqlserver';
  return 'postgres';
}

/** Relation bucket for an edge pointing at a node of the given IR type. */
export function relationForTargetType(type: string): { relation: string; protocol: string; async: boolean } {
  if (['postgres', 'mysql', 'mongodb', 'dynamodb', 'cache', 'firestore', 'sqlserver'].includes(type)) {
    return { relation: 'dbConnection', protocol: 'tcp', async: false };
  }
  if (type === 'queue') return { relation: 'queue', protocol: 'tcp', async: true };
  if (type === 'smtp') return { relation: 'smtp', protocol: 'smtp', async: false };
  return { relation: 'serviceCall', protocol: 'http', async: false };
}
