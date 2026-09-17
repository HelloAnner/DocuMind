// 移植自 apps/api-rs/src/api/documents.rs —— 原文下载与文件预览路由
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import type { AppEnv } from '../http/types.ts';
import { requirePermission } from '../auth/permissions.ts';
import {
  contextualPreviewUrl, fetchDocument, fetchPreviewDocument, fetchReadableDocument, requiredSql,
  signedPreviewUrl, encodePreviewAccessToken,
} from './documents_access.ts';
import { pathParam } from './documents_support.ts';
import {
  downloadDocumentContent, downloadOfficePdfPageFromDocument, downloadOfficePreviewPdf,
  downloadPdfPageFromDocument, fetchPreviewPageCount,
} from './documents_office.ts';
import {
  isOfficePreviewType, parseByteRange, previewTypeFor, sanitizeFileName, sourceStatusFor,
} from './documents_support.ts';
import { toRfc3339 } from '../infra/time.ts';
import type {
  FilePreviewManifest, FilePreviewManifestPage, FilePreviewResponse, FilePreviewUrlResponse,
  PreviewAccessQuery,
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
  const totalSize = await state.storage.size(storageKey);

  const range = c.req.header('range') ?? null;
  if (range !== null) {
    const parsed = parseByteRange(range, totalSize);
    if (parsed !== null) {
      const [start, end] = parsed;
      const bytes = await state.storage.getRange(storageKey, start, end);
      const headers = new Headers({
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
      });
      return new Response(bodyOf(bytes), { status: 206, headers });
    }
  }

  const bytes = await state.storage.get(storageKey);
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${sanitizeFileName(fileName)}"`,
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
    page_pdf_url_template: signedPreviewUrl(`/api/files/${docId}/preview/pages/{page}/pdf`, token),
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
  const pageCount = await fetchPreviewPageCount(state, doc);
  const textLayerAvailable = ['pdf', 'txt', 'md'].includes(doc.file_type);
  const pages: FilePreviewManifestPage[] = [];
  if (pageCount !== null && pageCount > 0) {
    for (let page = 1; page <= pageCount; page += 1) {
      pages.push({
        page, width: 595.28, height: 841.89, rotation: 0, text_layer_available: textLayerAvailable,
      });
    }
  }
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

/** Rust: download_file_preview_page_pdf */
export async function downloadFilePreviewPagePdf(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const query = previewAccessQuery(c);
  const docId = pathParam(c, 'doc_id');
  const rawPage = pathParam(c, 'page');
  if (!/^\d+$/.test(rawPage)) {
    throw AppError.badRequest('PREVIEW_PAGE_UNSUPPORTED', '页码无效');
  }
  const page = Number.parseInt(rawPage, 10);
  const doc = await fetchPreviewDocument(
    state, c.req.raw.headers, docId, query.preview_token, query.conversation_id,
  );
  if (doc.file_type === 'pdf') {
    return downloadPdfPageFromDocument(state, doc, page);
  }
  if (isOfficePreviewType(doc.file_type)) {
    return downloadOfficePdfPageFromDocument(state, doc, page);
  }
  throw AppError.badRequest('PREVIEW_PAGE_UNSUPPORTED', '当前文件类型不支持按页预览');
}

/** Rust: download_page_pdf —— /api/admin/documents/:doc_id/pages/:page/pdf */
export async function downloadDocumentPagePdf(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requirePermission(actor, 'document.upload');
  const sql = requiredSql(state, '文档页预览需要启用 PostgreSQL 数据库连接');
  const docId = pathParam(c, 'doc_id');
  const rawPage = pathParam(c, 'page');
  if (!/^\d+$/.test(rawPage)) {
    throw AppError.badRequest('PREVIEW_PAGE_UNSUPPORTED', '页码无效');
  }
  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  return downloadPdfPageFromDocument(state, doc, Number.parseInt(rawPage, 10));
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
    return downloadOfficePreviewPdf(state, doc);
  }
  return downloadDocumentContent(state, doc, c.req.raw.headers, true);
}