// 移植自 apps/api-rs/src/api/documents.rs —— 移动知识库 / 送入 OCR
import type { Context } from 'hono';
import type { TransactionSql } from 'postgres';
import { AppError } from '../errors.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requireKbPermission, requirePermission } from '../auth/permissions.ts';
import { PARSER_VERSION } from '../document/types.ts';
import { newUuid } from '../infra/uuid.ts';
import { nowRfc3339 } from '../infra/time.ts';
import type { AppEnv } from '../http/types.ts';
import { fetchDocument, requiredSql } from './documents_access.ts';
import { fetchActiveOcrJobId, updateDocumentSearchKb } from './documents_storage.ts';
import { fetchDocumentSummary } from './documents_chunks.ts';
import { spawnParseJob } from './documents_parse.ts';
import {
  pathParam, canMoveDocument, canSendToOcr, currentParserConfig, toJson,
} from './documents_support.ts';
import { OCR_RENDER_DPI } from './documents_types.ts';
import type { MoveDocumentRequest, SendToOcrResponse } from './documents_types.ts';

/** Rust: can_move_document + move_document_relations */
async function moveDocumentRelations(
  tx: TransactionSql, tenantId: string, docId: string, kbId: string,
): Promise<number> {
  const tables = [
    'document_parse_jobs', 'document_blocks', 'cleaned_blocks', 'document_tables',
    'document_table_cells', 'chunks', 'chunk_embeddings',
  ];
  let updated = 0;
  for (const table of tables) {
    const result = await tx.unsafe(
      `UPDATE ${table} SET kb_id = \$3 WHERE tenant_id = \$1 AND doc_id = \$2`,
      [tenantId, docId, kbId],
    );
    updated += result.count;
  }
  return updated;
}

/** Rust: move_document */
export async function moveDocument(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.upload');
  const sql = requiredSql(state, '文档移动需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');
  const req = (await c.req.json()) as MoveDocumentRequest;
  const targetKbId = req?.kb_id;

  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  requireKbPermission(actor, doc.kb_id, 'write');
  if (!actor.allowed_kb_ids.includes(targetKbId) && !actor.permissions.includes('kb.manage')) {
    throw AppError.kbScopeDenied();
  }
  if (doc.kb_id === targetKbId) {
    return c.json(await fetchDocumentSummary(sql, actor.tenant_id, docId));
  }
  if (!canMoveDocument(doc.parse_status)) {
    throw AppError.invalidState('MOVE_DOCUMENT_NOT_ALLOWED', '文档正在处理，达到稳定状态后才能移动');
  }

  let relatedRows = 0;
  let esUpdated = 0;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe('SET CONSTRAINTS fk_chunks_tenant_document, fk_embeddings_tenant_chunk DEFERRED');
      const updated = await tx.unsafe(
        `UPDATE documents
         SET kb_id = \$3, updated_at = NOW()
         WHERE tenant_id = \$1 AND id = \$2
           AND EXISTS (SELECT 1 FROM knowledge_base WHERE tenant_id = \$1 AND id = \$3)`,
        [actor.tenant_id, docId, targetKbId],
      );
      if (updated.count === 0) {
        throw AppError.notFound('DOCUMENT_NOT_FOUND', '文档或目标知识库不存在');
      }
      relatedRows = await moveDocumentRelations(tx, actor.tenant_id, docId, targetKbId);
      esUpdated = await updateDocumentSearchKb(state, doc, targetKbId);
      if (doc.parse_status === 'indexed' && esUpdated !== Math.max(0, doc.chunk_count)) {
        throw AppError.internal(
          `moving document ${docId} updated ${esUpdated} Elasticsearch chunks, expected ${doc.chunk_count}`,
        );
      }
    });
  } catch (error) {
    if (esUpdated > 0) {
      try {
        await updateDocumentSearchKb(state, doc, doc.kb_id);
      } catch (revertError) {
        console.error(`failed to revert elasticsearch kb update: ${(revertError as Error).message}`);
      }
    }
    throw error;
  }

  await recordAuditEvent(state.sql, actor, 'document.move', 'document', docId, {
    from_kb_id: doc.kb_id,
    to_kb_id: targetKbId,
    related_rows: relatedRows,
    es_updated_chunks: esUpdated,
  });

  return c.json(await fetchDocumentSummary(sql, actor.tenant_id, docId));
}

/** Rust: send_to_ocr */
export async function sendToOcr(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.reprocess');
  const sql = requiredSql(state, 'OCR 入队需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');

  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  requireKbPermission(actor, doc.kb_id, 'write');

  if (doc.parse_status === 'ocr_pending') {
    const activeOcrJobId = await fetchActiveOcrJobId(sql, actor.tenant_id, docId);
    if (activeOcrJobId !== null) {
      const body: SendToOcrResponse = {
        document_id: docId,
        ocr_job_id: activeOcrJobId,
        parse_status: 'ocr_pending',
        ocr_status: 'pending',
      };
      return c.json(body);
    }
  }

  if (!canSendToOcr(doc.parse_status)) {
    throw AppError.invalidState(
      'SEND_TO_OCR_NOT_ALLOWED', '只有低置信解析文档可以进入 OCR 增强队列');
  }
  if (doc.file_type !== 'pdf') {
    throw AppError.invalidState(
      'OCR_UNSUPPORTED_FILE_TYPE', '当前仅支持 PDF 文档进入 OCR 增强队列');
  }

  let bytes: Uint8Array;
  try {
    bytes = await state.storage.get(doc.storage_key);
  } catch (error) {
    throw AppError.badRequest(
      'ORIGINAL_FILE_MISSING',
      `无法读取原始文件 ${doc.storage_key}: ${(error as Error).message}`,
    );
  }

  const ocrJobId = newUuid();
  const parseVersion = doc.parse_version + 1;
  const parserConfig: Record<string, unknown> = {
    ...currentParserConfig(),
    job_kind: 'ocr',
    ocr_status: 'queued',
    ocr_engine: 'tesseract',
    ocr_render_dpi: OCR_RENDER_DPI,
    ocr_page_segmentation_mode: 3,
    source_parse_job_id: doc.latest_parse_job_id,
  };
  const parseIdentity = `ocr:${doc.id}:${ocrJobId}`;

  await sql.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO document_parse_jobs (
          parse_job_id, tenant_id, kb_id, doc_id, parser_version, parser_config,
          parse_identity, status, started_at
       )
       VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, 'ocr_queued', NOW())`,
      [ocrJobId, doc.tenant_id, doc.kb_id, doc.id, PARSER_VERSION, toJson(parserConfig), parseIdentity],
    );

    await tx.unsafe(
      `UPDATE documents
       SET parse_status = 'ocr_pending',
           metadata = metadata || \$1,
           updated_at = NOW()
       WHERE tenant_id = \$2 AND id = \$3`,
      [{
        ocr_status: 'pending',
        ocr_requested_at: nowRfc3339(),
        ocr_requested_by: actor.user_id,
        active_ocr_job_id: ocrJobId,
        ocr_source_parse_job_id: doc.latest_parse_job_id,
        previous_parse_status: doc.parse_status,
        parse_progress: 100,
      }, actor.tenant_id, doc.id],
    );
  });

  await recordAuditEvent(state.sql, actor, 'document.send_to_ocr', 'document', docId, {
    kb_id: doc.kb_id,
    title: doc.title,
    ocr_job_id: ocrJobId,
    source_parse_job_id: doc.latest_parse_job_id,
    previous_parse_status: doc.parse_status,
  });

  spawnParseJob(sql, {
    tenant_id: doc.tenant_id,
    kb_id: doc.kb_id,
    doc_id: doc.id,
    parse_job_id: ocrJobId,
    parse_version: parseVersion,
    title: doc.title,
    file_name: doc.file_name,
    mime_type: doc.mime_type,
    file_type: doc.file_type,
    parser_config: parserConfig,
    parse_identity: parseIdentity,
    bytes,
    embedding_config: state.config.rag.embedding,
    force_index: false,
  });

  const body: SendToOcrResponse = {
    document_id: doc.id,
    ocr_job_id: ocrJobId,
    parse_status: 'ocr_pending',
    ocr_status: 'pending',
  };
  return c.json(body);
}