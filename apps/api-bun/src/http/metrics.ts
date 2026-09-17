// 移植自 apps/api-rs/src/lib.rs 的 /api/metrics（Prometheus 文本格式）
import type { Sql } from 'postgres';
import type { AppConfig } from '../config.ts';
import {
  checkElasticsearch, checkObjectStorage, checkOk, checkOpenAiCompatibleEndpoint,
  checkPostgres, checkRedis, checkTcpUrl, withField, type DependencyCheck, type HealthDeps,
} from './health.ts';

function pushMetric(out: string[], name: string, labels: Array<[string, string]>, value: number | string): void {
  let line = name;
  if (labels.length > 0) {
    line += '{' + labels.map(([key, value]) => `${key}="${escapePrometheusLabel(value)}"`).join(',') + '}';
  }
  out.push(`${line} ${value}`);
}
function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
function sanitizePrometheusComment(value: string): string {
  return value.replace(/\n/g, ' ');
}

async function appendDatabaseMetrics(out: string[], sql: Sql): Promise<void> {
  out.push('# HELP documind_documents_total Total number of non-deleted documents.');
  out.push('# TYPE documind_documents_total gauge');
  const documents = await sql`
    SELECT COUNT(*)::bigint AS count FROM documents WHERE parse_status <> 'deleted'
  `;
  pushMetric(out, 'documind_documents_total', [], Number(documents[0]?.count ?? 0));

  out.push('# HELP documind_documents_by_status_total Documents grouped by parse_status.');
  out.push('# TYPE documind_documents_by_status_total gauge');
  const statuses = await sql`
    SELECT parse_status, COUNT(*)::bigint AS count
    FROM documents WHERE parse_status <> 'deleted'
    GROUP BY parse_status ORDER BY parse_status
  `;
  for (const row of statuses) {
    pushMetric(out, 'documind_documents_by_status_total', [['status', String(row.parse_status)]], Number(row.count));
  }

  out.push('# HELP documind_document_chunks_total Sum of chunk_count across documents.');
  out.push('# TYPE documind_document_chunks_total gauge');
  const chunks = await sql`
    SELECT COALESCE(SUM(chunk_count), 0)::bigint AS count
    FROM documents WHERE parse_status <> 'deleted'
  `;
  pushMetric(out, 'documind_document_chunks_total', [], Number(chunks[0]?.count ?? 0));

  out.push('# HELP documind_parse_jobs_by_status_total Parse jobs grouped by status.');
  out.push('# TYPE documind_parse_jobs_by_status_total gauge');
  const parseJobs = await sql`
    SELECT status, COUNT(*)::bigint AS count FROM document_parse_jobs
    GROUP BY status ORDER BY status
  `;
  for (const row of parseJobs) {
    pushMetric(out, 'documind_parse_jobs_by_status_total', [['status', String(row.status)]], Number(row.count));
  }

  out.push('# HELP documind_vector_jobs_by_status_total Durable vector jobs grouped by status.');
  out.push('# TYPE documind_vector_jobs_by_status_total gauge');
  const vectorJobs = await sql`SELECT status, COUNT(*)::bigint AS count FROM vector_jobs GROUP BY status ORDER BY status`;
  for (const row of vectorJobs) {
    pushMetric(out, 'documind_vector_jobs_by_status_total', [['status', String(row.status)]], Number(row.count));
  }

  out.push('# HELP documind_embeddings_by_status_total Chunk embeddings grouped by generation and index status.');
  out.push('# TYPE documind_embeddings_by_status_total gauge');
  const embeddingStatuses = await sql`
    SELECT status, index_status, COUNT(*)::bigint AS count
    FROM chunk_embeddings GROUP BY status, index_status ORDER BY status, index_status
  `;
  for (const row of embeddingStatuses) {
    pushMetric(out, 'documind_embeddings_by_status_total',
      [['status', String(row.status)], ['index_status', String(row.index_status)]], Number(row.count));
  }

  out.push('# HELP documind_conversations_total Total conversation sessions.');
  out.push('# TYPE documind_conversations_total gauge');
  const conversations = await sql`SELECT COUNT(*)::bigint AS count FROM conversation_sessions`;
  pushMetric(out, 'documind_conversations_total', [], Number(conversations[0]?.count ?? 0));

  out.push('# HELP documind_messages_by_role_total Conversation messages grouped by role.');
  out.push('# TYPE documind_messages_by_role_total gauge');
  const messageRoles = await sql`
    SELECT role, COUNT(*)::bigint AS count FROM conversation_messages
    GROUP BY role ORDER BY role
  `;
  for (const row of messageRoles) {
    pushMetric(out, 'documind_messages_by_role_total', [['role', String(row.role)]], Number(row.count));
  }

  out.push('# HELP documind_feedback_total Total conversation feedback rows.');
  out.push('# TYPE documind_feedback_total gauge');
  const feedback = await sql`SELECT COUNT(*)::bigint AS count FROM conversation_feedback`;
  pushMetric(out, 'documind_feedback_total', [], Number(feedback[0]?.count ?? 0));
}

export async function metricsPayload(deps: HealthDeps): Promise<string> {
  const { config } = deps;
  const postgres = await checkPostgres(deps.sql);
  const redis = await checkRedis(deps.redis);
  const elasticsearch = await checkElasticsearch(
    config.elasticsearchUrl, config.rag.embedding.indexAlias);
  const objectStorage = await checkObjectStorage(
    config.objectStorageProvider, config.objectStorageEndpoint, config.objectStorageBucket);
  const rabbitmq = await checkTcpUrl(config.rabbitmqUrl, 5672);
  const realLlm = await checkOpenAiCompatibleEndpoint(
    config.rag.generation.useRealLlm, config.rag.generation.baseUrl,
    config.rag.generation.apiKey, 'LLM');
  const embedding = await checkOpenAiCompatibleEndpoint(
    config.rag.embedding.enabled, config.rag.embedding.baseUrl,
    config.rag.embedding.apiKey, 'Embedding');
  const reranker: DependencyCheck = withField(withField(withField(checkOk(),
    'provider', config.rag.rerank.provider),
    'model', config.rag.rerank.model),
    'startup_probe', 'passed');

  const out: string[] = [];
  out.push('# HELP documind_up Whether the DocuMind process can render metrics.');
  out.push('# TYPE documind_up gauge');
  pushMetric(out, 'documind_up', [], 1);
  out.push('# HELP documind_dependency_up Dependency health from the same probes used by /api/health.');
  out.push('# TYPE documind_dependency_up gauge');
  const checks: Array<[string, DependencyCheck]> = [
    ['postgres', postgres], ['redis', redis], ['elasticsearch', elasticsearch],
    ['object_storage', objectStorage], ['rabbitmq', rabbitmq],
    ['real_llm', realLlm], ['embedding', embedding], ['reranker', reranker],
  ];
  for (const [name, check] of checks) {
    pushMetric(out, 'documind_dependency_up', [['dependency', name]], check.ok ? 1 : 0);
  }

  if (deps.sql) {
    try {
      await appendDatabaseMetrics(out, deps.sql);
      pushMetric(out, 'documind_database_metrics_available', [], 1);
    } catch (error) {
      pushMetric(out, 'documind_database_metrics_available', [], 0);
      out.push(`# documind_database_metrics_error ${sanitizePrometheusComment((error as Error).message)}`);
    }
    if (config.elasticsearchUrl && deps.vectorConsistency) {
      try {
        const snapshot = await deps.vectorConsistency();
        pushMetric(out, 'documind_vector_index_expected_chunks', [], snapshot.expected_chunks);
        pushMetric(out, 'documind_vector_index_actual_chunks', [], snapshot.actual_chunks);
        pushMetric(out, 'documind_vector_index_drift_chunks', [], snapshot.missing_or_stale_chunks);
      } catch (error) {
        out.push(`# documind_vector_consistency_error ${sanitizePrometheusComment((error as Error).message)}`);
      }
    }
  } else {
    pushMetric(out, 'documind_database_metrics_available', [], 0);
  }
  return out.join('\n') + '\n';
}
