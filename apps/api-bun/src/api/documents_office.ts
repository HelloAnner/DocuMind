// 移植自 apps/api-rs/src/api/documents.rs —— 文件内容/按页预览（含 Office 转 PDF、Range、预览缓存）
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../errors.ts';
import type { AppState } from '../state.ts';
import { extractSinglePagePdf, pdfPageCount } from './documents_pdf_page.ts';
import {
  isOfficePreviewType, mimeTypeForDocument, parseByteRange, sanitizeFileName, sha256Hex,
} from './documents_support.ts';
import { OFFICE_CONVERSION_TIMEOUT_SECONDS } from './documents_types.ts';
import type { DocumentRecord } from './documents_types.ts';

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function internalError(prefix: string, error: unknown): AppError {
  return AppError.internal(`${prefix}: ${(error as Error).message}`);
}

/** Rust: preview_cache_root */
export function previewCacheRoot(state: AppState): string {
  const baseDir = state.config.blobStorageDir;
  const parent = dirname(baseDir);
  return join(parent === '' ? baseDir : parent, 'preview_cache');
}

/** Rust: preview_cache_version */
export function previewCacheVersion(doc: DocumentRecord): string {
  return doc.latest_parse_job_id ?? doc.file_sha256;
}

/** Rust: source_file_hash */
function sourceFileHash(path: string): string {
  return sha256Hex(path).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Office -> PDF 预览
// ---------------------------------------------------------------------------

interface CommandOutcome {
  kind: 'ok' | 'timeout' | 'spawn-error';
  status: number;
  stdout: string;
  stderr: string;
  message: string;
}

async function runCommandWithTimeout(command: string[], timeoutSeconds: number): Promise<CommandOutcome> {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    return { kind: 'spawn-error', status: -1, stdout: '', stderr: '', message: (error as Error).message };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutSeconds * 1000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  clearTimeout(timer);
  if (timedOut) return { kind: 'timeout', status, stdout, stderr, message: '' };
  return { kind: 'ok', status, stdout, stderr, message: '' };
}

/** Rust: convert_office_to_pdf */
async function convertOfficeToPdf(inputPath: string, outputDir: string): Promise<string> {
  const profileDir = join(outputDir, 'lo-profile');
  try {
    await mkdir(profileDir, { recursive: true });
  } catch (error) {
    throw internalError('failed to create LibreOffice profile dir', error);
  }

  const stem = inputPath.split('/').pop() ?? 'source';
  const dot = stem.lastIndexOf('.');
  const name = dot > 0 ? stem.slice(0, dot) : stem;
  const outputPdf = join(outputDir, `${name === '' ? 'source' : name}.pdf`);

  let lastError: string | null = null;
  for (const commandName of ['soffice', 'libreoffice']) {
    const command = [
      commandName, '--headless', '--nologo', '--nofirststartwizard', '--nodefault', '--nolockcheck',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'pdf', '--outdir', outputDir, inputPath,
    ];
    const outcome = await runCommandWithTimeout(command, OFFICE_CONVERSION_TIMEOUT_SECONDS);
    if (outcome.kind === 'ok' && outcome.status === 0 && existsSync(outputPdf)) {
      return outputPdf;
    }
    if (outcome.kind === 'ok') {
      lastError = `${commandName} exited with status ${outcome.status}: stdout=${outcome.stdout} stderr=${outcome.stderr}`;
    } else if (outcome.kind === 'spawn-error') {
      lastError = `failed to execute ${commandName}: ${outcome.message}`;
    } else {
      lastError = `${commandName} timed out after ${OFFICE_CONVERSION_TIMEOUT_SECONDS}s`;
    }
  }

  throw AppError.internal(
    `office preview conversion failed: ${lastError ?? 'LibreOffice executable not found'}`,
  );
}

/** Rust: ensure_office_preview_pdf */
async function ensureOfficePreviewPdf(state: AppState, doc: DocumentRecord): Promise<string> {
  if (!isOfficePreviewType(doc.file_type)) {
    throw AppError.badRequest('OFFICE_PREVIEW_UNSUPPORTED', '当前文件类型不支持 Office PDF 预览');
  }

  const cacheDir = join(previewCacheRoot(state), 'office_pdfs', doc.id, previewCacheVersion(doc));
  const pdfPath = join(cacheDir, 'converted.pdf');
  if (existsSync(pdfPath)) return pdfPath;

  try {
    await mkdir(cacheDir, { recursive: true });
  } catch (error) {
    throw internalError('failed to create office preview cache dir', error);
  }

  const bytes = await state.storage.get(doc.storage_key);
  const inputPath = join(cacheDir, `source.${doc.file_type}`);
  try {
    await writeFile(inputPath, bytes);
  } catch (error) {
    throw internalError('failed to write office preview source', error);
  }

  const outputPath = await convertOfficeToPdf(inputPath, cacheDir);
  const tmpPath = pdfPath.replace(/\.pdf$/, '.tmp');
  try {
    await rename(outputPath, tmpPath);
    await rename(tmpPath, pdfPath);
  } catch (error) {
    throw internalError('failed to finalize converted office pdf', error);
  }
  return pdfPath;
}

/** Rust: office_preview_page_count */
async function officePreviewPageCount(state: AppState, doc: DocumentRecord): Promise<number | null> {
  if (!isOfficePreviewType(doc.file_type)) return null;
  const pdfPath = await ensureOfficePreviewPdf(state, doc);
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = new Uint8Array(await readFile(pdfPath));
  } catch (error) {
    throw internalError('failed to read office preview pdf', error);
  }
  return pdfPageCount(pdfBytes);
}

// ---------------------------------------------------------------------------
// 单页 PDF
// ---------------------------------------------------------------------------

/** Rust: download_pdf_page_from_path */
async function downloadPdfPageFromPath(
  state: AppState, doc: DocumentRecord, page: number, pdfPath: string,
): Promise<Response> {
  const cacheDir = join(
    previewCacheRoot(state), 'page_pdfs', doc.id, previewCacheVersion(doc), sourceFileHash(pdfPath),
  );
  const cachePath = join(cacheDir, `${page}.pdf`);
  const totalPath = join(cacheDir, 'total_pages.txt');

  if (!existsSync(cachePath)) {
    try {
      await mkdir(cacheDir, { recursive: true });
    } catch (error) {
      throw internalError('failed to create page pdf cache dir', error);
    }

    let pdfBytes: Uint8Array;
    try {
      pdfBytes = new Uint8Array(await readFile(pdfPath));
    } catch (error) {
      throw internalError('failed to read source preview pdf', error);
    }
    let singlePage: Uint8Array;
    let totalPages: number;
    try {
      const result = extractSinglePagePdf(pdfBytes, page);
      singlePage = result.bytes;
      totalPages = result.totalPages;
    } catch (error) {
      throw AppError.internal((error as Error).message);
    }

    const tmpPath = cachePath.replace(/\.pdf$/, '.tmp');
    try {
      await writeFile(tmpPath, singlePage);
      await rename(tmpPath, cachePath);
      await writeFile(totalPath, String(totalPages));
    } catch (error) {
      throw internalError('failed to finalize page pdf', error);
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(cachePath));
  } catch (error) {
    throw internalError('failed to read cached page pdf', error);
  }
  let totalPages = 0;
  try {
    const raw = await readFile(totalPath, 'utf8');
    const parsed = Number.parseInt(raw.trim(), 10);
    totalPages = Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    totalPages = 0;
  }

  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Expose-Headers': 'X-Total-Pages',
  });
  if (totalPages > 0) headers.set('X-Total-Pages', String(totalPages));
  return new Response(bodyOf(bytes), { status: 200, headers });
}

/** Rust: download_office_preview_pdf */
export async function downloadOfficePreviewPdf(
  state: AppState, doc: DocumentRecord,
): Promise<Response> {
  const pdfPath = await ensureOfficePreviewPdf(state, doc);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(pdfPath));
  } catch (error) {
    throw internalError('failed to read office preview pdf', error);
  }
  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="${sanitizeFileName(doc.title)}.pdf"`,
  });
  return new Response(bodyOf(bytes), { status: 200, headers });
}

/** Rust: download_pdf_page_from_document */
export async function downloadPdfPageFromDocument(
  state: AppState, doc: DocumentRecord, page: number,
): Promise<Response> {
  if (doc.file_type !== 'pdf') {
    throw AppError.badRequest('PREVIEW_PAGE_UNSUPPORTED', '只有 PDF 原文支持按页预览');
  }
  const pdfPath = join(state.config.blobStorageDir, doc.storage_key);
  if (existsSync(pdfPath)) {
    return downloadPdfPageFromPath(state, doc, page, pdfPath);
  }

  const cacheDir = join(previewCacheRoot(state), 'source_pdfs', doc.id, previewCacheVersion(doc));
  const sourcePath = join(cacheDir, 'source.pdf');
  if (!existsSync(sourcePath)) {
    try {
      await mkdir(cacheDir, { recursive: true });
    } catch (error) {
      throw internalError('failed to create source pdf cache dir', error);
    }
    const bytes = await state.storage.get(doc.storage_key);
    const tmpPath = sourcePath.replace(/\.pdf$/, '.tmp');
    try {
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, sourcePath);
    } catch (error) {
      throw internalError('failed to finalize source pdf', error);
    }
  }
  return downloadPdfPageFromPath(state, doc, page, sourcePath);
}

/** Rust: download_office_pdf_page_from_document */
export async function downloadOfficePdfPageFromDocument(
  state: AppState, doc: DocumentRecord, page: number,
): Promise<Response> {
  const pdfPath = await ensureOfficePreviewPdf(state, doc);
  return downloadPdfPageFromPath(state, doc, page, pdfPath);
}

/** Rust: fetch_preview_page_count */
export async function fetchPreviewPageCount(
  state: AppState, doc: DocumentRecord,
): Promise<number | null> {
  if (isOfficePreviewType(doc.file_type)) {
    return officePreviewPageCount(state, doc);
  }

  const sql = state.sql;
  if (sql !== null && doc.latest_parse_job_id !== null) {
    const rows = await sql.unsafe(
      `SELECT COALESCE((parser_config->>'page_count')::int, NULL)::int AS page_count
       FROM document_parse_jobs
       WHERE parse_job_id = \$1`,
      [doc.latest_parse_job_id],
    );
    const value = rows[0]?.page_count;
    if (value != null) return Number(value);
  }

  if (doc.file_type === 'pdf') {
    const pdfBytes = await state.storage.get(doc.storage_key);
    return pdfPageCount(pdfBytes);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 原文内容（Range/流式）
// ---------------------------------------------------------------------------

/** Rust: download_document_content */
export async function downloadDocumentContent(
  state: AppState, doc: DocumentRecord, reqHeaders: Headers, inline: boolean,
): Promise<Response> {
  const totalSize = await state.storage.size(doc.storage_key);
  const contentType = mimeTypeForDocument(doc);

  const range = reqHeaders.get('range');
  if (range !== null) {
    const parsed = parseByteRange(range, totalSize);
    if (parsed !== null) {
      const [start, end] = parsed;
      const bytes = await state.storage.getRange(doc.storage_key, start, end);
      const headers = new Headers({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
      });
      return new Response(bodyOf(bytes), { status: 206, headers });
    }
  }

  const bytes = await state.storage.get(doc.storage_key);
  const disposition = inline ? 'inline' : 'attachment';
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${disposition}; filename="${sanitizeFileName(doc.file_name)}"`,
  });
  return new Response(bodyOf(bytes), { status: 200, headers });
}
