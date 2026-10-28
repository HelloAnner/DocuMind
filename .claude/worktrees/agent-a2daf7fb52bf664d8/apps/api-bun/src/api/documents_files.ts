// 移植自 apps/api-rs/src/api/documents.rs —— 原文下载与文件预览路由
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { requirePermission } from '../auth/permissions.ts';
import { withObjectStorageTimeout } from '../files/service.ts';
import {
  contextualPreviewUrl, fetchPreviewDocument, fetchReadableDocument, requiredSql,
  signedPreviewUrl, encodePreviewAccessToken,
} from './documents_access.ts';
import { downloadDocumentContent, downloadOfficePreviewPdf, ensureOfficePreviewPdf } from './documents_office.ts';
import {
  isOfficePreviewType, parseByteRange, pathParam, previewTypeFor, rangeNotSatisfiable,
  sanitizeFileName, sourceStatusFor,
} from './documents_support.ts';
import { toRfc3339 } from '../infra/time.ts';
import type {
  FilePreviewManifest, FilePreviewResponse, FilePreviewUrlResponse, PreviewAccessQuery,
} from './documents_types.ts';

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rust: Query<PreviewAccessQuery>（UUID 解析失败时 axum 返回 400） */
export function previewAccessQuery(c: Context<AppEnv>): PreviewAccessQuery {
  const rawConversation = c.req.query('conversation_id');
  if (rawConversation !== undefined && !UUID_RE.test(rawConversation)) {
    throw AppError.badRequest('BAD_REQUEST', 'query 参数无效');
  }
  return {
    preview_token: c.req.query('preview_token') ?? null,
    conversation_id: rawConversation ?? null,
  };
}

/** Rust: download_original */
export async function downloadOriginal(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.upload');
  const sql = requiredSql(state, '文档下载需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');

  const rows = await sql.unsafe(
    `SELECT COALESCE(metadata->>'original_filename', storage_key) AS file_name, storage_key
     FROM documents WHERE tenant_id = \$1 AND id = \$2`,
    [actor.tenant_id, docId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('DOCUMENT_NOT_FOUND', '文档不存在或无权限');
  }
  const fileName = String(row.file_name);
  const storageKey = String(row.storage_key);
  const totalSize = await withObjectStorageTimeout(
    'head', (signal) => state.storage.size(storageKey, signal),
  );

  const range = c.req.header('range') ?? null;
  if (range !== null) {
    const parsed = parseByteRange(range, totalSize);
    if (parsed !== null) {
      const [start, end] = parsed;
      const bytes = await withObjectStorageTimeout(
        'get range', (signal) => state.storage.getRange(storageKey, start, end, signal),
      );
      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
        'Content-Length': String(end - start),
      });
      return new Response(bodyOf(bytes), { status: 206, headers });
    }
    return rangeNotSatisfiable(totalSize);
  }

  const bytes = await withObjectStorageTimeout(
    'get', (signal) => state.storage.get(storageKey, signal),
  );
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${sanitizeFileName(fileName)}"`,
    'Content-Length': String(totalSize),
  });
  return new Response(bodyOf(bytes), { status: 200, headers });
}

/** Rust: get_file_preview */
export async function getFilePreview(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const query = previewAccessQuery(c);
  const docId = pathParam(c, 'doc_id');
  const doc = await fetchReadableDocument(state, actor, docId, query.conversation_id);
  const body: FilePreviewResponse = {
    doc_id: doc.id,
    parse_job_id: doc.latest_parse_job_id,
    file_name: doc.file_name,
    format: doc.file_type,
    preview_type: previewTypeFor(doc.file_type),
    preview_url: contextualPreviewUrl(`/api/files/${docId}/preview/content`, query.conversation_id),
    manifest_url: contextualPreviewUrl(`/api/files/${docId}/preview/manifest`, query.conversation_id),
    source_status: sourceStatusFor(doc.parse_status),
  };
  return c.json(body);
}

/** Rust: get_file_preview_url */
export async function getFilePreviewUrl(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const query = previewAccessQuery(c);
  const docId = pathParam(c, 'doc_id');
  const doc = await fetchReadableDocument(state, actor, docId, query.conversation_id);

  const expiresInSeconds = state.config.objectStoragePresignExpireSeconds;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const token = await encodePreviewAccessToken(state, actor, doc.id, expiresAt);
  const body: FilePreviewUrlResponse = {
    doc_id: doc.id,
    parse_job_id: doc.latest_parse_job_id,
    file_name: doc.file_name,
    format: doc.file_type,
    preview_type: previewTypeFor(doc.file_type),
    expires_at: toRfc3339(expiresAt),
    expires_in_seconds: expiresInSeconds,
    preview_url: signedPreviewUrl(`/api/files/${docId}/preview/content`, token),
    manifest_url: signedPreviewUrl(`/api/files/${docId}/preview/manifest`, token),
  };
  return c.json(body);
}

/** Rust: get_file_preview_manifest */
export async function getFilePreviewManifest(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const query = previewAccessQuery(c);
  const docId = pathParam(c, 'doc_id');
  const doc = await fetchPreviewDocument(
    state, c.req.raw.headers, docId, query.preview_token, query.conversation_id,
  );
  let pageCount: number | null = null;
  if (state.sql !== null && doc.latest_parse_job_id !== null) {
    const rows = await state.sql.unsafe(
      `SELECT (parser_config->>'page_count')::int AS page_count
       FROM document_parse_jobs WHERE parse_job_id = \$1`,
      [doc.latest_parse_job_id],
    );
    const value = rows[0]?.page_count;
    if (value != null) pageCount = Number(value);
  }
  if (isOfficePreviewType(doc.file_type)) await ensureOfficePreviewPdf(state, doc);
  const textLayerAvailable = ['pdf', 'txt', 'md'].includes(doc.file_type);
  const pages: FilePreviewManifest['pages'] = [];
  const body: FilePreviewManifest = {
    doc_id: doc.id,
    parse_job_id: doc.latest_parse_job_id,
    file_name: doc.file_name,
    format: doc.file_type,
    preview_type: previewTypeFor(doc.file_type),
    page_count: pageCount,
    pages,
    text_layer_available: textLayerAvailable,
    conversion_status: isOfficePreviewType(doc.file_type) ? 'converted' : 'original',
  };
  return c.json(body);
}


/** Rust: download_file_preview_content */
export async function downloadFilePreviewContent(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const query = previewAccessQuery(c);
  const docId = pathParam(c, 'doc_id');
  const doc = await fetchPreviewDocument(
    state, c.req.raw.headers, docId, query.preview_token, query.conversation_id,
  );
  if (isOfficePreviewType(doc.file_type)) {
    return downloadOfficePreviewPdf(state, doc, c.req.raw.headers);
  }
  return downloadDocumentContent(state, doc, c.req.raw.headers, true);
}