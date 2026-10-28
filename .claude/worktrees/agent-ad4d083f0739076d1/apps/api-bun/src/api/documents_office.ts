// 文件内容预览：Office 转 PDF 缓存与原文 Range 响应。
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../errors.ts';
import { withObjectStorageTimeout } from '../files/service.ts';
import type { AppState } from '../state.ts';
import {
  isOfficePreviewType, mimeTypeForDocument, parseByteRange, rangeNotSatisfiable,
  sanitizeFileName,
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
  if (existsSync(outputPdf)) await rm(outputPdf, { force: true });

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
export async function ensureOfficePreviewPdf(state: AppState, doc: DocumentRecord): Promise<string> {
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

  const bytes = await withObjectStorageTimeout(
    'get', (signal) => state.storage.get(doc.storage_key, signal),
  );
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

/** Serve the cached Office conversion directly; PDF.js performs byte-range reads. */
export async function downloadOfficePreviewPdf(
  state: AppState, doc: DocumentRecord, reqHeaders: Headers,
): Promise<Response> {
  const pdfPath = await ensureOfficePreviewPdf(state, doc);
  const file = Bun.file(pdfPath);
  const totalSize = file.size;
  const range = reqHeaders.get('range');
  if (range !== null) {
    const parsed = parseByteRange(range, totalSize);
    if (parsed !== null) {
      const [start, end] = parsed;
      return new Response(await file.slice(start, end).arrayBuffer(), {
        status: 206,
        headers: {
          'Content-Type': 'application/pdf',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
          'Content-Length': String(end - start),
          'Cache-Control': 'private, max-age=86400',
        },
      });
    }
    return rangeNotSatisfiable(totalSize);
  }
  return new Response(file, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(totalSize),
      'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `inline; filename="${sanitizeFileName(doc.title)}.pdf"`,
    },
  });
}

// ---------------------------------------------------------------------------
// 原文内容（Range/流式）
// ---------------------------------------------------------------------------

/** Rust: download_document_content */
export async function downloadDocumentContent(
  state: AppState, doc: DocumentRecord, reqHeaders: Headers, inline: boolean,
): Promise<Response> {
  const totalSize = await withObjectStorageTimeout(
    'head', (signal) => state.storage.size(doc.storage_key, signal),
  );
  const contentType = mimeTypeForDocument(doc);

  const range = reqHeaders.get('range');
  if (range !== null) {
    const parsed = parseByteRange(range, totalSize);
    if (parsed !== null) {
      const [start, end] = parsed;
      const bytes = await withObjectStorageTimeout(
        'get range',
        (signal) => state.storage.getRange(doc.storage_key, start, end, signal),
      );
      const headers = new Headers({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end - 1}/${totalSize}`,
        'Content-Length': String(end - start),
      });
      return new Response(bodyOf(bytes), { status: 206, headers });
    }
    return rangeNotSatisfiable(totalSize);
  }

  const bytes = await withObjectStorageTimeout(
    'get', (signal) => state.storage.get(doc.storage_key, signal),
  );
  const disposition = inline ? 'inline' : 'attachment';
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${disposition}; filename="${sanitizeFileName(doc.file_name)}"`,
    'Content-Length': String(totalSize),
  });
  return new Response(bodyOf(bytes), { status: 200, headers });
}
