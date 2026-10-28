// 移植自 apps/api-rs/src/api/documents.rs —— 文档持久化辅助（KB 校验、索引清理、级联删除）
import type { Sql, TransactionSql } from 'postgres';
import { AppError } from '../errors.ts';
import { cancelDocument } from '../rag/vector_jobs.ts';
import { ElasticsearchChunkIndexer } from '../rag/vector_index.ts';
import type { AppState } from '../state.ts';
import type { DocumentRecord } from './documents_types.ts';

/** Rust: ensure_kb_exists */
export async function ensureKbExists(sql: Sql, tenantId: string, kbId: string): Promise<void> {
  const rows = await sql.unsafe(
    `SELECT 1 FROM knowledge_base WHERE tenant_id = \$1 AND id = \$2 AND status = 'active'`,
    [tenantId, kbId],
  );
  if (rows.length === 0) {
    throw AppError.badRequest('KNOWLEDGE_BASE_NOT_FOUND', '知识库不存在或不可用');
  }
}

/** Rust: fetch_active_ocr_job_id */
export async function fetchActiveOcrJobId(
  sql: Sql, tenantId: string, docId: string,
): Promise<string | null> {
  const rows = await sql.unsafe(
    `SELECT metadata->>'active_ocr_job_id' AS ocr_job_id
     FROM documents
     WHERE tenant_id = \$1 AND id = \$2`,
    [tenantId, docId],
  );
  const raw = rows[0]?.ocr_job_id;
  if (raw == null) return null;
  const value = String(raw);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

/** Rust: find_completed_parse_by_identity */
export async function findCompletedParseByIdentity(
  sql: Sql, docId: string, parseIdentity: string,
): Promise<{ parse_job_id: string; chunk_count: number; parse_status: string } | null> {
  const rows = await sql.unsafe(
    `SELECT j.parse_job_id,
            COUNT(c.id)::int AS chunk_count,
            COALESCE(j.parser_config->>'parse_status', 'indexed') AS parse_status
     FROM document_parse_jobs j
     LEFT JOIN chunks c ON c.parse_job_id = j.parse_job_id
     WHERE j.doc_id = \$1
       AND j.parse_identity = \$2
       AND j.status = 'completed'
     GROUP BY j.parse_job_id, j.parser_config
     ORDER BY j.completed_at DESC NULLS LAST
     LIMIT 1`,
    [docId, parseIdentity],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    parse_job_id: String(row.parse_job_id),
    chunk_count: Number(row.chunk_count),
    parse_status: String(row.parse_status),
  };
}

/** Rust: purge_document_conversations —— 返回被级联删除的会话数 */
export async function purgeDocumentConversations(
  tx: TransactionSql, tenantId: string, docId: string,
): Promise<number> {
  const result = await tx.unsafe(
    `WITH impacted AS (
         SELECT DISTINCT m.conversation_id
         FROM conversation_messages m
         JOIN conversation_citations c ON c.assistant_message_id = m.id
         WHERE m.tenant_id = \$1 AND c.doc_id = \$2
         UNION
         SELECT DISTINCT m.conversation_id
         FROM conversation_messages m
         JOIN conversation_retrieval_traces r ON r.message_id = m.id
         WHERE m.tenant_id = \$1 AND r.doc_id = \$2
     )
     DELETE FROM conversation_sessions s
     USING impacted i
     WHERE s.id = i.conversation_id AND s.tenant_id = \$1`,
    [tenantId, docId],
  );
  return result.count;
}

/** Rust: delete_document_from_search_index —— 返回 ES 删除的 chunk 数 */
export async function deleteDocumentFromSearchIndex(
  state: AppState, doc: DocumentRecord,
): Promise<number> {
  const url = state.config.elasticsearchUrl;
  if (url === null) {
    if (doc.parse_status === 'indexed' || doc.chunk_count > 0) {
      throw AppError.badRequest('ELASTICSEARCH_REQUIRED', '排除已切片文档需要可用的 Elasticsearch 配置');
    }
    return 0;
  }
  const indexer = new ElasticsearchChunkIndexer({
    baseUrl: url,
    indexName: state.config.rag.embedding.indexAlias,
    aliasName: state.config.rag.embedding.indexAlias,
    timeoutSeconds: 120,
  });
  return indexer.deleteDocumentChunks(doc.id);
}

/** Rust: update_document_search_kb —— 返回 ES 更新的 chunk 数 */
export async function updateDocumentSearchKb(
  state: AppState, doc: DocumentRecord, kbId: string,
): Promise<number> {
  if (doc.parse_status !== 'indexed') return 0;
  const url = state.config.elasticsearchUrl;
  if (url === null) {
    throw AppError.badRequest('ELASTICSEARCH_REQUIRED', '移动已索引文档需要可用的 Elasticsearch 配置');
  }
  const indexer = new ElasticsearchChunkIndexer({
    baseUrl: url,
    indexName: state.config.rag.embedding.indexAlias,
    aliasName: state.config.rag.embedding.indexAlias,
    timeoutSeconds: 120,
  });
  return indexer.updateDocumentKb(doc.tenant_id, doc.id, kbId);
}

/** Rust: rag::vector_jobs::cancel_document */
export async function cancelDocumentJobs(sql: Sql, docId: string): Promise<number> {
  return cancelDocument(sql, docId);
}
