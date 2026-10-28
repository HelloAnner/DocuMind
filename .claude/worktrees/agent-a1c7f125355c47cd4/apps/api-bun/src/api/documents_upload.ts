// 移植自 apps/api-rs/src/api/documents.rs —— 上传 / 替换文件（multipart）
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import { recordAuditEvent } from '../auth/audit.ts';
import { requireKbPermission, requirePermission } from '../auth/permissions.ts';
import { detectFileType } from '../document/mod.ts';
import type { FileType } from '../document/types.ts';
import { newUuid } from '../infra/uuid.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { cancelDocument } from '../rag/vector_jobs.ts';
import type { AppEnv } from '../http/types.ts';
import { fetchDocument, requiredSql } from './documents_access.ts';
import {
  cancelDocumentJobs, deleteDocumentFromSearchIndex, ensureKbExists,
} from './documents_storage.ts';
import { pathParam } from './documents_support.ts';
import { insertPendingParseJob, spawnParseJob } from './documents_parse.ts';
import {
  canReplaceFile, currentParserConfig, documentStorageKey, parseIdentityFor, sha256Hex,
  titleFromFileName,
} from './documents_support.ts';
import { MAX_UPLOAD_BYTES } from './documents_types.ts';
import type {
  ReplaceDocumentFileResponse, UploadDocumentResponse, UploadedFile,
} from './documents_types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** multipart 字段：FormData 的非字符串项（Bun/undici 类型不互通，这里用结构化最小接口） */
interface FormPart {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface FormLike {
  entries(): IterableIterator<[string, string | FormPart]>;
}

/** Rust: read_multipart_file */
export async function readMultipartFile(c: Context<AppEnv>): Promise<UploadedFile> {
  let form: FormLike;
  try {
    form = (await c.req.raw.formData()) as unknown as FormLike;
  } catch (error) {
    throw AppError.badRequest('INVALID_MULTIPART', `上传表单无效: ${(error as Error).message}`);
  }

  let fileName: string | null = null;
  let title: string | null = null;
  let mimeType: string | null = null;
  let uploadBatchId: string | null = null;
  let bytes: Uint8Array | null = null;

  for (const [fieldName, value] of form.entries()) {
    if (fieldName === 'file') {
      if (typeof value === 'string') {
        fileName = null;
        mimeType = 'application/octet-stream';
        bytes = new TextEncoder().encode(value);
      } else {
        fileName = value.name;
        mimeType = value.type === '' ? 'application/octet-stream' : value.type;
        bytes = new Uint8Array(await value.arrayBuffer());
      }
      continue;
    }
    if (fieldName === 'title') {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed !== '') title = trimmed;
      continue;
    }
    if (fieldName === 'upload_batch_id') {
      if (typeof value !== 'string') continue;
      const raw = value.trim();
      if (!UUID_RE.test(raw)) {
        throw AppError.badRequest('INVALID_UPLOAD_BATCH_ID', '上传批次 ID 格式无效');
      }
      uploadBatchId = raw;
    }
  }

  if (bytes === null) throw AppError.badRequest('FILE_REQUIRED', '缺少 file 字段');
  if (bytes.length === 0) throw AppError.badRequest('FILE_EMPTY', '上传文件为空');

  const resolvedFileName = fileName ?? 'document';
  return {
    title: title ?? titleFromFileName(resolvedFileName),
    file_name: resolvedFileName,
    mime_type: mimeType ?? 'application/octet-stream',
    upload_batch_id: uploadBatchId,
    bytes,
  };
}

/** Rust: upload_document */
export async function uploadDocument(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.upload');
  const kbId = pathParam(c, 'kb_id');
  requireKbPermission(actor, kbId, 'write');
  const sql = requiredSql(state, '文档上传需要启用 PostgreSQL 数据库连接');

  await ensureKbExists(sql, actor.tenant_id, kbId);

  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined && Number(contentLength) > MAX_UPLOAD_BYTES) {
    throw AppError.badRequest('UPLOAD_TOO_LARGE', '上传文件超过 100MB 限制');
  }

  const uploaded = await readMultipartFile(c);
  let fileFormat: FileType;
  try {
    fileFormat = await detectFileType(uploaded.file_name, uploaded.mime_type, uploaded.bytes);
  } catch (error) {
    throw AppError.badRequest('UNSUPPORTED_FILE_TYPE', (error as Error).message);
  }
  const fileType = fileFormat;
  const fileSha256 = sha256Hex(uploaded.bytes);
  const docId = newUuid();
  const parseJobId = newUuid();
  const storageKey = documentStorageKey(actor.tenant_id, kbId, docId, fileSha256, fileType);
  const parserConfig = currentParserConfig();
  const parseIdentity = parseIdentityFor(fileSha256, parserConfig);

  await state.storage.put(storageKey, uploaded.bytes);

  await sql.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO documents (
          id, tenant_id, kb_id, title, file_type, file_size_bytes, storage_key,
          file_sha256, parse_status, parse_version, chunk_count, metadata, created_by, upload_batch_id
       )
       VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, 1, \$10, \$11, \$12, \$13)`,
      [docId, actor.tenant_id, kbId, uploaded.title, fileType, uploaded.bytes.length, storageKey,
        fileSha256, 'uploaded', 0,
        {
          original_filename: uploaded.file_name,
          mime_type: uploaded.mime_type,
          active_parse_job_id: parseJobId,
        },
        actor.user_id, uploaded.upload_batch_id],
    );

    await insertPendingParseJob(tx, {
      tenant_id: actor.tenant_id, kb_id: kbId, doc_id: docId,
      parse_job_id: parseJobId, parse_version: 1,
    }, parserConfig, parseIdentity);

    await tx.unsafe(
      `UPDATE documents
       SET latest_parse_job_id = \$1, updated_at = NOW()
       WHERE tenant_id = \$2 AND id = \$3`,
      [parseJobId, actor.tenant_id, docId],
    );
  });

  await recordAuditEvent(state.sql, actor, 'document.upload', 'document', docId, {
    kb_id: kbId,
    file_name: uploaded.file_name,
    title: uploaded.title,
    file_type: fileType,
    file_size: uploaded.bytes.length,
    parse_job_id: parseJobId,
  });

  spawnParseJob(sql, {
    tenant_id: actor.tenant_id,
    kb_id: kbId,
    doc_id: docId,
    parse_job_id: parseJobId,
    parse_version: 1,
    title: uploaded.title,
    file_name: uploaded.file_name,
    mime_type: uploaded.mime_type,
    file_type: fileType,
    parser_config: parserConfig,
    parse_identity: parseIdentity,
    bytes: uploaded.bytes,
    embedding_config: state.config.rag.embedding,
    force_index: false,
  });

  const body: UploadDocumentResponse = {
    document_id: docId,
    parse_job_id: parseJobId,
    title: uploaded.title,
    file_type: fileType,
    parse_status: 'uploaded',
    block_count: 0,
    table_count: 0,
    chunk_count: 0,
    storage_key: storageKey,
  };
  return c.json(body);
}

/** Rust: replace_document_file */
export async function replaceDocumentFile(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.reprocess');
  const sql = requiredSql(state, '文档替换需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');

  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  requireKbPermission(actor, doc.kb_id, 'write');
  if (!canReplaceFile(doc.parse_status)) {
    throw AppError.invalidState('REPLACE_FILE_NOT_ALLOWED', '当前文档正在处理，不能替换文件');
  }

  const uploaded = await readMultipartFile(c);
  let fileFormat: FileType;
  try {
    fileFormat = await detectFileType(uploaded.file_name, uploaded.mime_type, uploaded.bytes);
  } catch (error) {
    throw AppError.badRequest('UNSUPPORTED_FILE_TYPE', (error as Error).message);
  }
  const fileType = fileFormat;
  const fileSha256 = sha256Hex(uploaded.bytes);
  if (fileSha256 === doc.file_sha256) {
    throw AppError.badRequest('REPLACEMENT_UNCHANGED', '替换文件内容与当前原文件一致');
  }

  const parseJobId = newUuid();
  const parseVersion = doc.parse_version + 1;
  const storageKey = documentStorageKey(actor.tenant_id, doc.kb_id, doc.id, fileSha256, fileType);
  const parserConfig = { ...currentParserConfig(), replacement_generation: parseJobId };
  const parseIdentity = parseIdentityFor(fileSha256, parserConfig);

  await state.storage.put(storageKey, uploaded.bytes);
  await sql.unsafe(
    `UPDATE documents
     SET parse_status = 'excluded_from_search',
         metadata = metadata || \$1,
         updated_at = NOW()
     WHERE tenant_id = \$2 AND id = \$3`,
    [{ replacement_cleanup_pending: true, previous_parse_status: doc.parse_status },
      actor.tenant_id, doc.id],
  );
  await cancelDocumentJobs(sql, doc.id);

  let deletedChunks: number;
  try {
    deletedChunks = await deleteDocumentFromSearchIndex(state, doc);
  } catch (error) {
    try {
      await state.storage.delete(storageKey);
    } catch (cleanupError) {
      console.error(`failed to delete replaced storage object: ${(cleanupError as Error).message}`);
    }
    throw error;
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE documents
       SET title = \$1,
           file_type = \$2,
           file_size_bytes = \$3,
           storage_key = \$4,
           file_sha256 = \$5,
           metadata = metadata || \$6,
           updated_at = NOW()
       WHERE tenant_id = \$7 AND id = \$8`,
      [uploaded.title, fileType, uploaded.bytes.length, storageKey, fileSha256,
        {
          original_filename: uploaded.file_name,
          mime_type: uploaded.mime_type,
          replaced_file_at: nowRfc3339(),
          replaced_file_by: actor.user_id,
          previous_file_sha256: doc.file_sha256,
          previous_storage_key: doc.storage_key,
          previous_parse_status: doc.parse_status,
          replacement_es_deleted_chunks: deletedChunks,
          replacement_cleanup_pending: false,
        },
        actor.tenant_id, doc.id],
    );
    await insertPendingParseJob(tx, {
      tenant_id: actor.tenant_id, kb_id: doc.kb_id, doc_id: doc.id,
      parse_job_id: parseJobId, parse_version: parseVersion,
    }, parserConfig, parseIdentity);
  });
  await cancelDocument(sql, doc.id);

  if (doc.storage_key !== storageKey) {
    try {
      await state.storage.delete(doc.storage_key);
    } catch (error) {
      console.error(`failed to delete previous storage object: ${(error as Error).message}`);
    }
  }

  await recordAuditEvent(state.sql, actor, 'document.replace_file', 'document', docId, {
    kb_id: doc.kb_id,
    title: uploaded.title,
    file_name: uploaded.file_name,
    file_type: fileType,
    file_size: uploaded.bytes.length,
    parse_job_id: parseJobId,
    parse_version: parseVersion,
    previous_file_sha256: doc.file_sha256,
    previous_parse_status: doc.parse_status,
    es_deleted_chunks: deletedChunks,
  });

  spawnParseJob(sql, {
    tenant_id: actor.tenant_id,
    kb_id: doc.kb_id,
    doc_id: doc.id,
    parse_job_id: parseJobId,
    parse_version: parseVersion,
    title: uploaded.title,
    file_name: uploaded.file_name,
    mime_type: uploaded.mime_type,
    file_type: fileType,
    parser_config: parserConfig,
    parse_identity: parseIdentity,
    bytes: uploaded.bytes,
    embedding_config: state.config.rag.embedding,
    force_index: false,
  });

  const body: ReplaceDocumentFileResponse = {
    document_id: doc.id,
    parse_job_id: parseJobId,
    parse_status: 'uploaded',
    parse_version: parseVersion,
    title: uploaded.title,
    file_type: fileType,
    file_sha256: fileSha256,
    storage_key: storageKey,
  };
  return c.json(body);
}