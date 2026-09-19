// 移植自 apps/api-rs/src/api/documents.rs 的 router() —— 路由汇总
// 路由路径/方法与 Rust 逐条对齐；document-jobs 在 Rust 里是独立 router，这里挂到同一棵树上（路径等价）。
import { Hono } from 'hono';
import type { AppEnv } from '../http/types.ts';
import { uploadDocument, replaceDocumentFile } from './documents_upload.ts';
import { listDocuments, getDocument, getDocumentDiagnostics } from './documents_query.ts';
import {
  deleteDocument, reprocessDocument, retryParse, forceIndexDocument, excludeFromSearch,
  retryDocuments,
} from './documents_lifecycle.ts';
import { moveDocument, sendToOcr } from './documents_move_ocr.ts';
import {
  downloadOriginal, getFilePreview, getFilePreviewUrl, getFilePreviewManifest,
  downloadFilePreviewContent,
} from './documents_files.ts';
import { documentJobsRouter } from './document_jobs_router.ts';

export function documentsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/api/knowledge-bases/:kb_id/documents', uploadDocument);

  router.get('/api/admin/documents', listDocuments);
  // 静态段先注册，避免与 /api/admin/documents/:doc_id 的 POST 冲突
  router.post('/api/admin/documents/retry', retryDocuments);
  router.get('/api/admin/documents/:doc_id/diagnostics', getDocumentDiagnostics);
  router.get('/api/admin/documents/:doc_id', getDocument);
  router.delete('/api/admin/documents/:doc_id', deleteDocument);
  router.post('/api/admin/documents/:doc_id', reprocessDocument);
  router.get('/api/admin/documents/:doc_id/original', downloadOriginal);
  router.post('/api/admin/documents/:doc_id/move', moveDocument);
  router.post('/api/admin/documents/:doc_id/retry', retryParse);
  router.post('/api/admin/documents/:doc_id/force-index', forceIndexDocument);
  router.post('/api/admin/documents/:doc_id/exclude-from-search', excludeFromSearch);
  router.post('/api/admin/documents/:doc_id/replace-file', replaceDocumentFile);
  router.post('/api/admin/documents/:doc_id/send-to-ocr', sendToOcr);

  router.get('/api/files/:doc_id/preview', getFilePreview);
  router.get('/api/files/:doc_id/preview-url', getFilePreviewUrl);
  router.get('/api/files/:doc_id/preview/manifest', getFilePreviewManifest);
  router.get('/api/files/:doc_id/preview/content', downloadFilePreviewContent);

  router.route('/', documentJobsRouter());

  return router;
}

export { recoverInterruptedDocumentJobs, resumePendingDocumentJobs } from './documents_parse.ts';
