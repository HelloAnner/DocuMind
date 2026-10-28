// 移植自 apps/api-rs/src/api/documents.rs —— 删除/重处理/重试/排除检索/OCR（生命周期端点）
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import { withObjectStorageTimeout } from '../files/service.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requireKbPermission, requirePermission } from '../auth/permissions.ts';
import { newUuid } from '../infra/uuid.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { cancelDocument } from '../rag/vector_jobs.ts';
import type { AppEnv } from '../http/types.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { AppState } from '../state.ts';
import { fetchDocument, requiredSql } from './documents_access.ts';
import {
  cancelDocumentJobs, deleteDocumentFromSearchIndex, findCompletedParseByIdentity,
  purgeDocumentConversations,
} from './documents_storage.ts';
import { pathParam } from './documents_support.ts';
import { enqueueDocumentJob, insertPendingParseJob, spawnParseJob } from './documents_parse.ts';
import { fetchDocumentSummary } from './documents_chunks.ts';
import {
  canExcludeFromSearch, currentParserConfig, parseIdentityFor,
} from './documents_support.ts';
import type {
  DeleteDocumentResponse, ExcludeFromSearchResponse, ReprocessDocumentResponse,
  RetryDocumentsRequest,
} from './documents_types.ts';

/** Rust: delete_document */
export async function deleteDocument(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.delete');
  const sql = requiredSql(state, '文档删除需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');

  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  requireKbPermission(actor, doc.kb_id, 'write');

  await sql.unsafe(
    `UPDATE documents
     SET parse_status = 'excluded_from_search',
         metadata = metadata || \$1,
         updated_at = NOW()
     WHERE tenant_id = \$2 AND id = \$3`,
    [{
      delete_pending: true,
      delete_requested_at: nowRfc3339(),
      delete_requested_by: actor.user_id,
      previous_parse_status: doc.parse_status,
    }, actor.tenant_id, docId],
  );
  await cancelDocument(sql, docId);
  const esDeletedChunks = await deleteDocumentFromSearchIndex(state, doc);
  await state.storage.delete(doc.storage_key);

  const deletedConversations = await sql.begin(async (tx) =>
    purgeDocumentConversations(tx, actor.tenant_id, docId));
  await sql.unsafe(
    `DELETE FROM documents WHERE tenant_id = \$1 AND id = \$2`,
    [actor.tenant_id, docId],
  );

  await recordAuditEvent(state.sql, actor, 'document.delete', 'document', docId, {
    kb_id: doc.kb_id,
    title: doc.title,
    file_type: doc.file_type,
    storage_key: doc.storage_key,
    es_deleted_chunks: esDeletedChunks,
    deleted_conversations: deletedConversations,
  });

  const body: DeleteDocumentResponse = { document_id: docId, status: 'deleted' };
  return c.json(body);
}

/** Rust: reprocess_document */
export async function reprocessDocument(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.reprocess');
  const docId = pathParam(c, 'doc_id');
  const resp = await reprocessOrRetryDocument(state, actor, docId, false, false);
  await recordAuditEvent(state.sql, actor, 'document.reprocess', 'document', docId, {
    parse_job_id: resp.parse_job_id,
    parse_version: resp.parse_version,
    reused_existing_parse: resp.reused_existing_parse,
  });
  return c.json(resp);
}

/** Rust: retry_parse */
export async function retryParse(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.reprocess');
  const docId = pathParam(c, 'doc_id');
  const retry = await reprocessOrRetryDocument(state, actor, docId, true, false);
  await recordAuditEvent(state.sql, actor, 'document.retry', 'document', docId, {
    parse_job_id: retry.parse_job_id,
    parse_version: retry.parse_version,
  });
  const sql = requiredSql(state, '文档查询需要启用 PostgreSQL 数据库连接');
  const summary = await fetchDocumentSummary(sql, actor.tenant_id, docId);
  return c.json(summary);
}

/** Rust: force_index_document */
export async function forceIndexDocument(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.reprocess');
  const docId = pathParam(c, 'doc_id');
  const resp = await reprocessOrRetryDocument(state, actor, docId, true, true);
  await recordAuditEvent(state.sql, actor, 'document.force_index', 'document', docId, {
    parse_job_id: resp.parse_job_id,
    parse_version: resp.parse_version,
  });
  return c.json(resp);
}

/** Rust: exclude_from_search */
export async function excludeFromSearch(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.reprocess');
  const sql = requiredSql(state, '文档检索排除需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');

  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  requireKbPermission(actor, doc.kb_id, 'write');

  if (doc.parse_status === 'excluded_from_search') {
    const deleted = await deleteDocumentFromSearchIndex(state, doc);
    await sql.unsafe(
      `UPDATE documents
       SET metadata = metadata || \$1, updated_at = NOW()
       WHERE tenant_id = \$2 AND id = \$3`,
      [{ search_cleanup_pending: false, es_deleted_chunks: deleted }, actor.tenant_id, docId],
    );
    const body: ExcludeFromSearchResponse = {
      document_id: docId, status: 'excluded_from_search', es_deleted_chunks: deleted,
    };
    return c.json(body);
  }

  if (!canExcludeFromSearch(doc.parse_status)) {
    throw AppError.invalidState(
      'EXCLUDE_FROM_SEARCH_NOT_ALLOWED', '只有已完成、失败或低置信文档可以被排除出检索');
  }

  await sql.unsafe(
    `UPDATE documents
     SET parse_status = 'excluded_from_search',
         metadata = metadata || \$1,
         updated_at = NOW()
     WHERE tenant_id = \$2 AND id = \$3`,
    [{
      excluded_from_search: true,
      excluded_from_search_at: nowRfc3339(),
      excluded_from_search_by: actor.user_id,
      previous_parse_status: doc.parse_status,
      search_cleanup_pending: true,
      parse_progress: 100,
    }, actor.tenant_id, docId],
  );
  await cancelDocument(sql, docId);
  const deleted = await deleteDocumentFromSearchIndex(state, doc);
  await sql.unsafe(
    `UPDATE documents
     SET metadata = metadata || \$1, updated_at = NOW()
     WHERE tenant_id = \$2 AND id = \$3`,
    [{ search_cleanup_pending: false, es_deleted_chunks: deleted }, actor.tenant_id, docId],
  );

  await recordAuditEvent(state.sql, actor, 'document.exclude_from_search', 'document', docId, {
    kb_id: doc.kb_id,
    title: doc.title,
    previous_parse_status: doc.parse_status,
    es_deleted_chunks: deleted,
  });

  const body: ExcludeFromSearchResponse = {
    document_id: docId, status: 'excluded_from_search', es_deleted_chunks: deleted,
  };
  return c.json(body);
}

/** Rust: retry_documents */
export async function retryDocuments(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.reprocess');
  const req = (await c.req.json()) as RetryDocumentsRequest;
  const docIds = Array.isArray(req?.doc_ids) ? req.doc_ids : [];
  if (docIds.length === 0) {
    throw AppError.badRequest('DOC_IDS_EMPTY', '请选择要重试的文档');
  }
  if (docIds.length > 50) {
    throw AppError.badRequest('DOC_IDS_TOO_MANY', '一次最多重试 50 个文档');
  }

  let retried = 0;
  for (const docId of docIds) {
    await reprocessOrRetryDocument(state, actor, docId, true, false);
    retried += 1;
  }
  await recordAuditEvent(state.sql, actor, 'document.retry_batch', 'document', null, {
    doc_ids: docIds,
    retried,
  });
  return c.json({ retried });
}

/** Rust: reprocess_or_retry_document */
export async function reprocessOrRetryDocument(
  state: AppState, actor: CurrentActor, docId: string, force: boolean, forceIndex: boolean,
): Promise<ReprocessDocumentResponse> {
  const sql = requiredSql(state, '文档重解析需要启用 PostgreSQL 数据库连接');
  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  requireKbPermission(actor, doc.kb_id, 'write');

  if (forceIndex && doc.parse_status !== 'parse_low_confidence') {
    throw AppError.invalidState(
      'FORCE_INDEX_NOT_ALLOWED', '只有低置信解析文档可以由管理员确认后强制索引');
  }
  if (forceIndex && doc.chunk_count <= 0) {
    throw AppError.invalidState(
      'FORCE_INDEX_UNAVAILABLE', '当前低置信文档没有有效切片，不能强制进入索引');
  }

  let bytes: Uint8Array;
  try {
    bytes = await withObjectStorageTimeout(
      'get', (signal) => state.storage.get(doc.storage_key, signal),
    );
  } catch (error) {
    throw AppError.badRequest(
      'ORIGINAL_FILE_MISSING',
      `无法读取原始文件 ${doc.storage_key}: ${(error as Error).message}`,
    );
  }

  const parserConfig = currentParserConfig();
  const parseIdentity = parseIdentityFor(doc.file_sha256, parserConfig);
  const newParseVersion = doc.parse_version + 1;

  if (force) {
    await sql.unsafe(
      `UPDATE documents
       SET parse_status = 'excluded_from_search',
           metadata = metadata || \$1,
           updated_at = NOW()
       WHERE tenant_id = \$2 AND id = \$3`,
      [{ reprocess_cleanup_pending: true, previous_parse_status: doc.parse_status },
        actor.tenant_id, doc.id],
    );
    await cancelDocumentJobs(sql, doc.id);
    const deletedChunks = await deleteDocumentFromSearchIndex(state, doc);
    await sql.unsafe(
      `UPDATE documents
       SET metadata = metadata || \$1, updated_at = NOW()
       WHERE tenant_id = \$2 AND id = \$3`,
      [{ reprocess_cleanup_pending: false, reprocess_es_deleted_chunks: deletedChunks },
        actor.tenant_id, doc.id],
    );
  }

  if (!force) {
    const found = await findCompletedParseByIdentity(sql, doc.id, parseIdentity);
    if (found !== null) {
      await sql.unsafe(
        `UPDATE documents
         SET latest_parse_job_id = \$1,
             parse_status = \$2,
             parse_version = \$3,
             chunk_count = \$4,
             updated_at = NOW()
         WHERE tenant_id = \$5 AND id = \$6`,
        [found.parse_job_id, found.parse_status, newParseVersion, found.chunk_count,
          actor.tenant_id, doc.id],
      );

      if (found.parse_status === 'chunked' && found.chunk_count > 0) {
        await cancelDocument(sql, doc.id);
        await enqueueDocumentJob(
          sql, doc.tenant_id, doc.kb_id, doc.id, found.parse_job_id,
          state.config.rag.embedding, true,
        );
      }

      return {
        document_id: doc.id,
        parse_job_id: found.parse_job_id,
        parse_status: found.parse_status,
        parse_version: newParseVersion,
        chunk_count: found.chunk_count,
        block_count: 0,
        table_count: 0,
        reused_existing_parse: true,
      };
    }
  }

  const parseJobId = newUuid();
  await sql.begin(async (tx) => {
    await insertPendingParseJob(tx, {
      tenant_id: doc.tenant_id, kb_id: doc.kb_id, doc_id: doc.id,
      parse_job_id: parseJobId, parse_version: newParseVersion,
    }, parserConfig, parseIdentity);
  });
  await cancelDocument(sql, doc.id);

  spawnParseJob(sql, {
    tenant_id: doc.tenant_id,
    kb_id: doc.kb_id,
    doc_id: doc.id,
    parse_job_id: parseJobId,
    parse_version: newParseVersion,
    title: doc.title,
    file_name: doc.file_name,
    mime_type: doc.mime_type,
    file_type: doc.file_type,
    parser_config: parserConfig,
    parse_identity: parseIdentity,
    bytes,
    embedding_config: state.config.rag.embedding,
    force_index: forceIndex,
  });

  return {
    document_id: doc.id,
    parse_job_id: parseJobId,
    parse_status: 'uploaded',
    parse_version: newParseVersion,
    block_count: 0,
    table_count: 0,
    chunk_count: 0,
    reused_existing_parse: false,
  };
}