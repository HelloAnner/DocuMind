import { posix } from 'node:path';
import { Hono, type Context } from 'hono';
import type { Sql } from 'postgres';
import { requirePermission } from '../auth/permissions.ts';
import { AppError } from '../errors.ts';
import { contentDisposition } from '../http/content_disposition.ts';
import { requireScope } from './external_api.ts';
import type { AppEnv } from '../http/types.ts';
import type { FileScope } from '../models/user_file.ts';
import { isUuid } from '../infra/uuid.ts';
import { validateUserUpload } from '../files/extract.ts';
import {
  createStoredUserFile,
  deleteOwnedUserFile,
  getOwnedUserFile,
  listOwnedUserFiles,
  MAX_USER_FILE_BYTES,
  normalizeUserFilePath,
  publicUserFile,
  withObjectStorageTimeout,
} from '../files/service.ts';
import { ownedSession } from './conversations_support.ts';

export function filesRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get('/api/files', listFiles);
  router.post('/api/files', uploadFile);
  router.get('/api/files/:id', getFile);
  router.delete('/api/files/:id', deleteFile);
  router.get('/api/files/:id/download', downloadFile);
  return router;
}

async function listFiles(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireFileAccess(actor, false);
  const sql = requiredSql(state.sql);
  const scope = fileScope(c);
  // 空间文件不挂会话，conversation_id 只对个人文件有意义
  const conversationId = scope === 'space' ? null : optionalConversationId(c);
  if (conversationId) await ownedSession(state, actor, conversationId);
  return c.json({
    items: await listOwnedUserFiles(sql, actor.tenant_id, actor.user_id, conversationId, scope),
  });
}

async function uploadFile(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  const sql = requiredSql(state.sql);
  requireFileAccess(actor, true);
  const form = await boundedMultipartFormData(c.req.raw);
  const upload = form.get('file');
  if (upload === null || typeof upload === 'string') {
    throw AppError.badRequest('FILE_REQUIRED', 'multipart file 字段必填');
  }
  if (upload.size > MAX_USER_FILE_BYTES) {
    throw AppError.badRequest('FILE_TOO_LARGE', '单个用户文件不得超过 25 MB');
  }
  const rawConversationId = form.get('conversation_id');
  const scope = fileScope(c);
  const rawConversation = typeof rawConversationId === 'string' && rawConversationId.trim()
    ? rawConversationId.trim() : null;
  const conversationId = scope === 'space' ? null : rawConversation;
  if (conversationId) {
    if (!isUuid(conversationId)) throw invalidConversationId();
    await ownedSession(state, actor, conversationId);
  }
  const rawPath = form.get('path');
  if (rawPath !== null && typeof rawPath !== 'string') {
    throw AppError.badRequest('INVALID_FILE_PATH', 'path 必须是字符串');
  }
  const path = normalizeUserFilePath(rawPath, upload.name);
  const bytes = new Uint8Array(await upload.arrayBuffer());
  let mimeType: string;
  try {
    mimeType = await validateUserUpload(upload.name, posix.basename(path), bytes);
  } catch (error) {
    throw AppError.badRequest(
      'UNSUPPORTED_OR_INVALID_FILE',
      `文件格式不受支持或内容无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const file = await createStoredUserFile(sql, state.storage, {
    tenantId: actor.tenant_id,
    userId: actor.user_id,
    conversationId,
    path,
    mimeType,
    source: 'upload',
    bytes,
    scope,
  });
  return c.json(publicUserFile(file), 201);
}

async function getFile(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireFileAccess(actor, false);
  const file = await getOwnedUserFile(
    requiredSql(state.sql), actor.tenant_id, actor.user_id, fileId(c));
  return c.json(publicUserFile(file));
}

async function deleteFile(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireFileAccess(actor, true);
  const id = fileId(c);
  await deleteOwnedUserFile(
    requiredSql(state.sql),
    state.storage,
    actor.tenant_id,
    actor.user_id,
    id,
    actor.is_super_admin || actor.roles.some((role) =>
      ['enterprise_admin', 'tenant_owner', 'tenant_admin'].includes(role)),
  );
  return c.json({ id, status: 'deleted' });
}

async function downloadFile(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireFileAccess(actor, false);
  const file = await getOwnedUserFile(
    requiredSql(state.sql), actor.tenant_id, actor.user_id, fileId(c));
  const bytes = await withObjectStorageTimeout(
    'get', (signal) => state.storage.get(file.storage_key, signal),
  );
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    headers: {
      'Content-Type': file.mime_type,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': contentDisposition(file.name),
    },
  });
}

function optionalConversationId(c: Context<AppEnv>): string | null {
  const value = c.req.query('conversation_id')?.trim();
  if (!value) return null;
  if (!isUuid(value)) throw invalidConversationId();
  return value;
}

// scope 是普通业务参数，只决定「看哪一类文件」；真正的授权范围仍然来自 actor 的
// tenant_id，客户端无法通过 scope 越权。
function fileScope(c: Context<AppEnv>): FileScope {
  const value = c.req.query('scope')?.trim();
  if (!value) return 'personal';
  if (value === 'personal' || value === 'space') return value;
  throw AppError.badRequest('INVALID_FILE_SCOPE', 'scope 只能是 personal 或 space');
}

function fileId(c: Context<AppEnv>): string {
  const value = c.req.param('id');
  if (!value || !isUuid(value)) {
    throw AppError.badRequest('INVALID_PATH_PARAM', '路径参数必须是 UUID');
  }
  return value;
}

function requiredSql(sql: Sql | null): Sql {
  if (!sql) throw AppError.badRequest('DATABASE_REQUIRED', '用户文件需要 PostgreSQL');
  return sql;
}

function invalidConversationId(): AppError {
  return AppError.badRequest('INVALID_CONVERSATION_ID', 'conversation_id 必须是 UUID');
}

export async function boundedMultipartFormData(
  request: Request,
  maxBytes = MAX_USER_FILE_BYTES + 128 * 1024,
) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw AppError.badRequest('INVALID_MULTIPART', '请求必须使用 multipart/form-data');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) {
      throw AppError.badRequest('INVALID_CONTENT_LENGTH', 'Content-Length 无效');
    }
    if (size > maxBytes) throw uploadRequestTooLarge();
  }
  if (!request.body) throw AppError.badRequest('FILE_REQUIRED', 'multipart 请求体不能为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw uploadRequestTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw AppError.badRequest('INVALID_MULTIPART', 'multipart 请求体无效');
  }
}

function uploadRequestTooLarge(): AppError {
  return AppError.payloadTooLarge('UPLOAD_REQUEST_TOO_LARGE', '上传请求体超过限制');
}
function requireFileAccess(actor: Context<AppEnv>['var']['actor'], write: boolean): void {
  requirePermission(actor, 'chat.ask');
  if (actor.api_client_id !== null) {
    requireScope(actor, write ? 'conversations:write' : 'conversations:read');
  }
}

