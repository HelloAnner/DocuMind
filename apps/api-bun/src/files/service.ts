import { posix } from 'node:path';
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import { nowRfc3339, toRfc3339 } from '../infra/time.ts';
import { isUuid, newUuid } from '../infra/uuid.ts';
import type { StoredUserFile, UserFile, UserFileSource } from '../models/user_file.ts';
import type { ObjectStorage } from '../storage/types.ts';
import {
  extractUserFileText,
  type ExtractedFileText,
  MAX_FILE_CONTEXT_CHARS,
  MAX_TOTAL_FILE_CONTEXT_CHARS,
} from './extract.ts';

export const MAX_USER_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 10;
export const OBJECT_STORAGE_TIMEOUT_MS = 30_000;
const PENDING_RESERVATION_MS = 5 * 60_000;
const CLEANUP_CLAIM_LEASE_MS = 2 * 60_000;
const CLEANUP_RETRY_BASE_MS = 60_000;
const MAX_CLEANUP_BATCH = 25;
const activeCleanupDrains = new WeakSet<object>();

interface StoredFileInput {
  tenantId: string;
  userId: string;
  conversationId: string | null;
  path: string;
  mimeType: string;
  source: UserFileSource;
  bytes: Uint8Array;
  messageId?: string;
}

export interface PreparedMessageFiles {
  file_ids: string[];
  files: UserFile[];
  context: string;
}

export function normalizeUserFilePath(rawPath: string | null | undefined, fallbackName: string): string {
  const fallback = safeFileName(fallbackName);
  const supplied = rawPath?.trim() ?? '';
  const candidate = supplied === ''
    ? fallback
    : supplied.endsWith('/') ? supplied + fallback : supplied;
  if (candidate.length > 500 || candidate.startsWith('/') || candidate.startsWith('\\')
    || candidate.includes('\\') || candidate.includes('\0') || /^[A-Za-z]:/u.test(candidate)) {
    throw invalidPath();
  }
  const parts = candidate.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'
    || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw invalidPath();
  }
  return parts.join('/');
}

export function safeFileName(rawName: string): string {
  const base = posix.basename(rawName.replace(/\\/gu, '/')).trim();
  const safe = base.replace(/[\u0000-\u001f\u007f/\\]/gu, '_').slice(0, 255);
  if (!safe || safe === '.' || safe === '..') return 'file';
  return safe;
}

export function userFileStorageKey(
  tenantId: string,
  userId: string,
  fileId: string,
  versionId: string,
  name: string,
): string {
  const objectName = safeFileName(name).replace(/[^A-Za-z0-9._-]/gu, '_') || 'file';
  return `tenants/${tenantId}/users/${userId}/files/${fileId}/${versionId}/${objectName}`;
}

export function mimeTypeForPath(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  const mimeByExtension: Record<string, string> = {
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
  };
  return mimeByExtension[extension] ?? 'application/octet-stream';
}

export async function createStoredUserFile(
  sql: Sql,
  storage: ObjectStorage,
  input: StoredFileInput,
): Promise<StoredUserFile> {
  if (input.bytes.byteLength > MAX_USER_FILE_BYTES) {
    throw AppError.badRequest('FILE_TOO_LARGE', '单个用户文件不得超过 25 MB');
  }
  const path = normalizeUserFilePath(input.path, input.path);
  const name = safeFileName(posix.basename(path));
  const id = newUuid();
  const storageKey = userFileStorageKey(input.tenantId, input.userId, id, newUuid(), name);
  const reservationToken = newUuid();
  await reserveObjectCleanup(sql, storageKey, reservationToken);
  await withObjectStorageTimeout(
    'put', (signal) => storage.put(storageKey, input.bytes, signal),
  );
  try {
    return await sql.begin(async (tx) => {
      await lockPendingObjectCleanup(tx, storageKey, reservationToken);
      const rows = await tx.unsafe(
        `INSERT INTO user_file
          (id, tenant_id, user_id, conversation_id, name, path, mime_type, size_bytes,
           source, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, tenant_id, user_id, conversation_id, name, path, mime_type,
           size_bytes, source, storage_key, extracted_text, extraction_truncated,
           created_at, updated_at`,
        [id, input.tenantId, input.userId, input.conversationId, name, path,
          input.mimeType || mimeTypeForPath(path), input.bytes.byteLength, input.source, storageKey],
      );
      await tx.unsafe(
        'DELETE FROM user_file_object_cleanup WHERE storage_key = $1',
        [storageKey],
      );
      if (input.messageId) {
        await tx.unsafe(
          `INSERT INTO conversation_message_file (message_id, file_id, tenant_id, user_id)
           VALUES ($1, $2, $3, $4)`,
          [input.messageId, id, input.tenantId, input.userId],
        );
      }
      return storedUserFile(rows[0]!);
    });
  } catch (error) {
    if (databaseCode(error) === '23505') {
      throw AppError.conflictWith('FILE_PATH_EXISTS', `文件路径已存在: ${path}`);
    }
    throw error;
  }
}

export async function listOwnedUserFiles(
  sql: Sql,
  tenantId: string,
  userId: string,
  conversationId: string | null = null,
): Promise<UserFile[]> {
  const rows = await sql.unsafe(
    `SELECT id, tenant_id, user_id, conversation_id, name, path, mime_type,
       size_bytes, source, storage_key, extracted_text, extraction_truncated,
       created_at, updated_at
     FROM user_file
     WHERE tenant_id = $1 AND user_id = $2
       AND ($3::uuid IS NULL OR conversation_id = $3)
     ORDER BY updated_at DESC, path ASC`,
    [tenantId, userId, conversationId],
  );
  return rows.map((row) => publicUserFile(storedUserFile(row)));
}

export async function getOwnedUserFile(
  sql: Sql,
  tenantId: string,
  userId: string,
  fileId: string,
): Promise<StoredUserFile> {
  if (!isUuid(fileId)) throw fileNotFound();
  const rows = await sql.unsafe(
    `SELECT id, tenant_id, user_id, conversation_id, name, path, mime_type,
       size_bytes, source, storage_key, extracted_text, extraction_truncated,
       created_at, updated_at
     FROM user_file WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [fileId, tenantId, userId],
  );
  if (!rows[0]) throw fileNotFound();
  return storedUserFile(rows[0]);
}

export async function deleteOwnedUserFile(
  sql: Sql,
  storage: ObjectStorage,
  tenantId: string,
  userId: string,
  fileId: string,
): Promise<void> {
  const result = await sql.unsafe(
    'DELETE FROM user_file WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
    [fileId, tenantId, userId],
  );
  if (result.count !== 1) throw fileNotFound();
  await drainObjectCleanup(sql, storage).catch(logCleanupFailure);
}

export async function prepareMessageFiles(
  sql: Sql,
  storage: ObjectStorage,
  tenantId: string,
  userId: string,
  conversationId: string,
  rawFileIds: unknown,
): Promise<PreparedMessageFiles> {
  const fileIds = validateFileIds(rawFileIds);
  if (fileIds.length === 0) return { file_ids: [], files: [], context: '' };
  const files = await loadOwnedFiles(sql, tenantId, userId, fileIds);
  for (const file of files) {
    if (file.conversation_id && file.conversation_id !== conversationId) throw fileNotFound();
  }

  let remaining = MAX_TOTAL_FILE_CONTEXT_CHARS;
  let totalTruncated = false;
  const sections: string[] = [];
  for (const file of files) {
    const extracted = await extractedText(sql, storage, file);
    if (remaining <= 0) {
      totalTruncated = true;
      break;
    }
    const slice = extracted.text.slice(0, remaining);
    sections.push(`--- 文件: ${file.path} (${file.mime_type}) ---\n${slice}`);
    remaining -= slice.length;
    if (slice.length < extracted.text.length) totalTruncated = true;
  }
  if (totalTruncated) {
    sections.push(`[已截断：本次文件总上下文最多 ${MAX_TOTAL_FILE_CONTEXT_CHARS} 字符，单文件最多 ${MAX_FILE_CONTEXT_CHARS} 字符]`);
  }
  return {
    file_ids: fileIds,
    files: files.map((file) => publicUserFile({
      ...file,
      conversation_id: conversationId,
    })),
    context: `<user_files>\n${sections.join('\n\n')}\n</user_files>`,
  };
}



export async function queryMessageFiles(
  sql: Sql,
  tenantId: string,
  userId: string,
  messageId: string,
): Promise<UserFile[]> {
  const rows = await sql.unsafe(
    `SELECT f.id, f.tenant_id, f.user_id, f.conversation_id, f.name, f.path,
       f.mime_type, f.size_bytes, f.source, f.storage_key, f.extracted_text,
       f.extraction_truncated, f.created_at, f.updated_at
     FROM conversation_message_file mf
     JOIN user_file f ON f.id = mf.file_id AND f.tenant_id = mf.tenant_id AND f.user_id = mf.user_id
     WHERE mf.message_id = $1 AND mf.tenant_id = $2 AND mf.user_id = $3
     ORDER BY mf.created_at, f.path`,
    [messageId, tenantId, userId],
  );
  return rows.map((row) => publicUserFile(storedUserFile(row)));
}


export async function updateStoredUserFile(
  sql: Sql,
  storage: ObjectStorage,
  file: StoredUserFile,
  bytes: Uint8Array,
  messageId: string,
): Promise<StoredUserFile> {
  if (bytes.byteLength > MAX_USER_FILE_BYTES) {
    throw AppError.badRequest('FILE_TOO_LARGE', '单个用户文件不得超过 25 MB');
  }
  const storageKey = userFileStorageKey(
    file.tenant_id, file.user_id, file.id, newUuid(), file.name,
  );
  const reservationToken = newUuid();
  await reserveObjectCleanup(sql, storageKey, reservationToken);
  await withObjectStorageTimeout('put', (signal) => storage.put(storageKey, bytes, signal));
  const updated = await sql.begin(async (tx) => {
    await lockPendingObjectCleanup(tx, storageKey, reservationToken);
    const rows = await tx.unsafe(
      `UPDATE user_file SET size_bytes = $1, mime_type = $2, storage_key = $3,
         source = 'sandbox', extracted_text = NULL, extraction_truncated = FALSE,
         updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5 AND user_id = $6
       RETURNING id, tenant_id, user_id, conversation_id, name, path, mime_type,
         size_bytes, source, storage_key, extracted_text, extraction_truncated,
         created_at, updated_at`,
      [bytes.byteLength, mimeTypeForPath(file.path), storageKey,
        file.id, file.tenant_id, file.user_id],
    );
    if (!rows[0]) throw fileNotFound();
    await tx.unsafe(
      `INSERT INTO user_file_object_cleanup(storage_key)
       VALUES ($1) ON CONFLICT (storage_key) DO NOTHING`,
      [file.storage_key],
    );
    await tx.unsafe(
      'DELETE FROM user_file_object_cleanup WHERE storage_key = $1',
      [storageKey],
    );
    await tx.unsafe(
      `INSERT INTO conversation_message_file (message_id, file_id, tenant_id, user_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [messageId, file.id, file.tenant_id, file.user_id],
    );
    return storedUserFile(rows[0]);
  });
  await drainObjectCleanup(sql, storage).catch(logCleanupFailure);
  return updated;
}
async function reserveObjectCleanup(
  sql: Sql,
  storageKey: string,
  reservationToken: string,
): Promise<void> {
  const rows = await sql.unsafe(
    `INSERT INTO user_file_object_cleanup(storage_key, reservation_token, available_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'))
     ON CONFLICT (storage_key) DO NOTHING
     RETURNING id`,
    [storageKey, reservationToken, PENDING_RESERVATION_MS],
  );
  if (!rows[0]) throw new Error(`object cleanup reservation conflict: ${storageKey}`);
}

async function lockPendingObjectCleanup(
  sql: Pick<Sql, 'unsafe'>,
  storageKey: string,
  reservationToken: string,
): Promise<void> {
  const rows = await sql.unsafe(
    `SELECT storage_key FROM user_file_object_cleanup
     WHERE storage_key = $1 AND reservation_token = $2 AND claim_token IS NULL
     FOR UPDATE`,
    [storageKey, reservationToken],
  );
  if (!rows[0]) throw new Error(`object cleanup reservation claimed or missing: ${storageKey}`);
}

interface CleanupClaim {
  id: string;
  storageKey: string;
  claimToken: string;
  attempts: number;
}

export async function withObjectStorageTimeout<T>(
  operation: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = OBJECT_STORAGE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error(`object storage ${operation} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function claimObjectCleanup(sql: Sql, limit: number): Promise<CleanupClaim[]> {
  const claimToken = newUuid();
  const boundedLimit = Math.min(Math.max(1, limit), MAX_CLEANUP_BATCH);
  return await sql.begin(async (tx) => {
    const rows = await tx.unsafe(
      `WITH due AS (
         SELECT id FROM user_file_object_cleanup
         WHERE available_at <= NOW()
         ORDER BY id LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE user_file_object_cleanup cleanup
       SET claim_token = $2, reservation_token = NULL,
           available_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       FROM due
       WHERE cleanup.id = due.id
       RETURNING cleanup.id, cleanup.storage_key, cleanup.attempts`,
      [boundedLimit, claimToken, CLEANUP_CLAIM_LEASE_MS],
    );
    return rows.map((row) => ({
      id: String(row.id),
      storageKey: String(row.storage_key),
      claimToken,
      attempts: Number(row.attempts),
    }));
  });
}

async function completeReferencedCleanup(sql: Sql, claim: CleanupClaim): Promise<boolean> {
  return await sql.begin(async (tx) => {
    const references = await tx.unsafe(
      'SELECT storage_key FROM user_file WHERE storage_key = $1 FOR KEY SHARE',
      [claim.storageKey],
    );
    if (!references[0]) return false;
    await tx.unsafe(
      `DELETE FROM user_file_object_cleanup
       WHERE id = $1 AND storage_key = $2 AND claim_token = $3`,
      [claim.id, claim.storageKey, claim.claimToken],
    );
    return true;
  });
}

async function completeObjectCleanup(sql: Sql, claim: CleanupClaim): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `DELETE FROM user_file_object_cleanup
       WHERE id = $1 AND storage_key = $2 AND claim_token = $3`,
      [claim.id, claim.storageKey, claim.claimToken],
    );
  });
}

async function rescheduleObjectCleanup(
  sql: Sql,
  claim: CleanupClaim,
  error: unknown,
): Promise<void> {
  const delayMs = Math.min(
    CLEANUP_RETRY_BASE_MS * (2 ** Math.min(claim.attempts, 6)),
    60 * 60_000,
  );
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE user_file_object_cleanup
       SET claim_token = NULL, attempts = attempts + 1, last_error = $1,
           available_at = NOW() + ($2 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE id = $3 AND storage_key = $4 AND claim_token = $5`,
      [
        error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
        delayMs, claim.id, claim.storageKey, claim.claimToken,
      ],
    );
  });
}

export async function drainObjectCleanup(
  sql: Sql,
  storage: ObjectStorage,
  limit = MAX_CLEANUP_BATCH,
  storageTimeoutMs = OBJECT_STORAGE_TIMEOUT_MS,
): Promise<number> {
  const lockKey = sql as unknown as object;
  if (activeCleanupDrains.has(lockKey)) return 0;
  activeCleanupDrains.add(lockKey);
  try {
    const claims = await claimObjectCleanup(sql, limit);
    let cleaned = 0;
    for (const claim of claims) {
      if (await completeReferencedCleanup(sql, claim)) continue;
      try {
        await withObjectStorageTimeout(
          'delete',
          (signal) => storage.delete(claim.storageKey, signal),
          storageTimeoutMs,
        );
        await completeObjectCleanup(sql, claim);
        cleaned += 1;
      } catch (error) {
        await rescheduleObjectCleanup(sql, claim, error);
      }
    }
    return cleaned;
  } finally {
    activeCleanupDrains.delete(lockKey);
  }
}

export function startObjectCleanupWorker(sql: Sql, storage: ObjectStorage): void {
  const run = () => { void drainObjectCleanup(sql, storage).catch(logCleanupFailure); };
  run();
  setInterval(run, 60_000).unref();
}

function logCleanupFailure(error: unknown): void {
  console.error(`[documind][files] object cleanup failed: ${
    error instanceof Error ? error.message : String(error)
  }`);
}


export function publicUserFile(file: StoredUserFile): UserFile {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    mime_type: file.mime_type,
    size_bytes: file.size_bytes,
    source: file.source,
    ...(file.conversation_id ? { conversation_id: file.conversation_id } : {}),
    created_at: file.created_at,
    updated_at: file.updated_at,
    download_url: `/api/files/${file.id}/download`,
  };
}

function validateFileIds(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !isUuid(id))) {
    throw AppError.badRequest('INVALID_FILE_IDS', 'file_ids 必须是 UUID 字符串数组');
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_MESSAGE_FILES) {
    throw AppError.badRequest('TOO_MANY_FILES', `单条消息最多关联 ${MAX_MESSAGE_FILES} 个文件`);
  }
  return ids;
}

async function loadOwnedFiles(
  sql: Sql,
  tenantId: string,
  userId: string,
  fileIds: string[],
): Promise<StoredUserFile[]> {
  const rows = await sql.unsafe(
    `SELECT id, tenant_id, user_id, conversation_id, name, path, mime_type,
       size_bytes, source, storage_key, extracted_text, extraction_truncated,
       created_at, updated_at
     FROM user_file
     WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])
     ORDER BY array_position($3::uuid[], id)`,
    [tenantId, userId, fileIds],
  );
  if (rows.length !== fileIds.length) throw fileNotFound();
  return rows.map(storedUserFile);
}

async function extractedText(
  sql: Sql,
  storage: ObjectStorage,
  file: StoredUserFile,
): Promise<ExtractedFileText> {
  if (file.extracted_text !== null) {
    return { text: file.extracted_text, truncated: file.extraction_truncated };
  }
  let extracted: ExtractedFileText;
  try {
    const bytes = await withObjectStorageTimeout(
      'get', (signal) => storage.get(file.storage_key, signal),
    );
    extracted = await extractUserFileText(file.name, file.mime_type, bytes);
  } catch (error) {
    throw AppError.badRequest(
      'FILE_EXTRACTION_FAILED',
      `无法提取文件 ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await sql.unsafe(
    `UPDATE user_file SET extracted_text = $1, extraction_truncated = $2, updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4 AND user_id = $5`,
    [extracted.text, extracted.truncated, file.id, file.tenant_id, file.user_id],
  );
  return extracted;
}


type FileRow = Record<string, unknown>;

function storedUserFile(row: FileRow): StoredUserFile {
  const conversation = row.conversation_id;
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    user_id: String(row.user_id),
    name: String(row.name),
    path: String(row.path),
    mime_type: String(row.mime_type),
    size_bytes: Number(row.size_bytes),
    source: String(row.source) === 'sandbox' ? 'sandbox' : 'upload',
    ...(conversation ? { conversation_id: String(conversation) } : {}),
    storage_key: String(row.storage_key),
    extracted_text: typeof row.extracted_text === 'string' ? row.extracted_text : null,
    extraction_truncated: row.extraction_truncated === true,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    download_url: `/api/files/${String(row.id)}/download`,
  };
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return toRfc3339(value);
  if (typeof value === 'string') return value;
  return nowRfc3339();
}

function databaseCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return String(error.code);
}

function invalidPath(): AppError {
  return AppError.badRequest('INVALID_FILE_PATH', '文件路径必须是安全的相对路径');
}

function fileNotFound(): AppError {
  return AppError.notFound('FILE_NOT_FOUND', '文件不存在或无权限');
}
