// 移植自 apps/api-rs/src/api/documents.rs —— 文档访问与预览令牌
import type { Sql } from 'postgres';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../errors.ts';
import { requireKbPermission } from '../auth/permissions.ts';
import { claimsFromAuthorizationHeader } from '../auth/jwt.ts';
import { actorFromClaims } from '../auth/actor.ts';
import { validateAndRenewAuthSession } from '../auth/session.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { AppState } from '../state.ts';
import type { DocumentRecord, FilePreviewAccessClaims } from './documents_types.ts';
import { isConversationFileAccessible } from './conversation_file_access.ts';

const DOCUMENT_NOT_FOUND_MESSAGE = '文档不存在或无权限';
const EXCLUDED_CODE = 'DOCUMENT_EXCLUDED_FROM_SEARCH';
const EXCLUDED_MESSAGE = '文档已排除检索，原文预览不可用于问答来源';

export function requiredSql(state: AppState, message: string): Sql {
  const sql = state.sql;
  if (sql === null) throw AppError.badRequest('DATABASE_REQUIRED', message);
  return sql;
}

/** Rust: fetch_document */
export async function fetchDocument(
  sql: Sql, tenantId: string, docId: string,
): Promise<DocumentRecord> {
  const rows = await sql.unsafe(
    `SELECT id, tenant_id, kb_id, title, file_type,
            COALESCE(metadata->>'original_filename', storage_key) AS file_name,
            COALESCE(metadata->>'mime_type', 'application/octet-stream') AS mime_type,
            storage_key, file_sha256, parse_version, parse_status, latest_parse_job_id, chunk_count
     FROM documents
     WHERE tenant_id = \$1 AND id = \$2`,
    [tenantId, docId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('DOCUMENT_NOT_FOUND', DOCUMENT_NOT_FOUND_MESSAGE);
  }
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    kb_id: String(row.kb_id),
    title: String(row.title),
    file_type: String(row.file_type),
    file_name: String(row.file_name),
    mime_type: String(row.mime_type),
    storage_key: String(row.storage_key),
    file_sha256: String(row.file_sha256),
    parse_version: Number(row.parse_version),
    parse_status: String(row.parse_status),
    latest_parse_job_id: row.latest_parse_job_id == null ? null : String(row.latest_parse_job_id),
    chunk_count: Number(row.chunk_count),
  };
}

/** Rust: fetch_readable_document */
export async function fetchReadableDocument(
  state: AppState, actor: CurrentActor, docId: string, conversationId: string | null,
): Promise<DocumentRecord> {
  const sql = requiredSql(state, '文件预览需要启用 PostgreSQL 数据库连接');
  const doc = await fetchDocument(sql, actor.tenant_id, docId);
  try {
    requireKbPermission(actor, doc.kb_id, 'read');
  } catch (accessError) {
    if (conversationId === null) throw accessError;
    const allowed = await isConversationFileAccessible(
      sql, actor, conversationId, doc.id, doc.kb_id,
    );
    if (!allowed) throw accessError;
  }
  if (doc.parse_status === 'excluded_from_search') {
    throw AppError.invalidState(EXCLUDED_CODE, EXCLUDED_MESSAGE);
  }
  return doc;
}

/** Rust: actor_from_bearer_token —— 无 Bearer 或解码失败时返回 null（交给 preview_token 分支） */
export async function actorFromBearerTokenIfPresent(
  state: AppState, headers: Headers,
): Promise<CurrentActor | null> {
  const authorization = headers.get('authorization');
  if (authorization === null) return null;
  let claims;
  try {
    claims = await claimsFromAuthorizationHeader(state.config, authorization);
  } catch {
    return null;
  }
  if (claims.sid !== null) {
    await validateAndRenewAuthSession(state.redis, state.config, claims);
  }
  return actorFromClaims({ sql: state.sql, config: state.config }, claims);
}

/** Rust: fetch_preview_document */
export async function fetchPreviewDocument(
  state: AppState, headers: Headers, docId: string, previewToken: string | null,
  conversationId: string | null,
): Promise<DocumentRecord> {
  const actor = await actorFromBearerTokenIfPresent(state, headers);
  if (actor !== null) {
    return fetchReadableDocument(state, actor, docId, conversationId);
  }
  if (previewToken === null) throw AppError.unauthorized();
  const claims = await decodePreviewAccessToken(state, previewToken);
  if (claims.doc_id !== docId || claims.scope !== 'file.preview.read') {
    throw AppError.forbiddenWith('PREVIEW_TOKEN_SCOPE_DENIED', '预览链接无权访问该文件');
  }
  const sql = requiredSql(state, '文件预览需要启用 PostgreSQL 数据库连接');
  const doc = await fetchDocument(sql, claims.tenant_id, docId);
  if (doc.parse_status === 'excluded_from_search') {
    throw AppError.invalidState(EXCLUDED_CODE, EXCLUDED_MESSAGE);
  }
  return doc;
}

/** Rust: encode_preview_access_token */
export async function encodePreviewAccessToken(
  state: AppState, actor: CurrentActor, docId: string, expiresAt: Date,
): Promise<string> {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  if (!Number.isFinite(exp) || exp < 0) {
    throw AppError.badRequest('PREVIEW_TOKEN_EXP_INVALID', '预览链接过期时间无效');
  }
  const key = new TextEncoder().encode(state.config.jwtSecret);
  return new SignJWT({ tenant_id: actor.tenant_id, doc_id: docId, scope: 'file.preview.read' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(actor.user_id)
    .setExpirationTime(exp)
    .sign(key);
}

/** Rust: decode_preview_access_token —— 任何解码失败（含过期）都映射为 PREVIEW_TOKEN_INVALID */
export async function decodePreviewAccessToken(
  state: AppState, token: string,
): Promise<FilePreviewAccessClaims> {
  try {
    const key = new TextEncoder().encode(state.config.jwtSecret);
    const { payload } = await jwtVerify(token, key);
    const tenantId = payload['tenant_id'];
    const docId = payload['doc_id'];
    const scope = payload['scope'];
    const exp = payload['exp'];
    if (payload.sub === undefined || typeof tenantId !== 'string'
      || typeof docId !== 'string' || typeof scope !== 'string' || typeof exp !== 'number') {
      throw AppError.unauthorizedWith('PREVIEW_TOKEN_INVALID', '预览链接无效或已过期');
    }
    return { sub: String(payload.sub), tenant_id: tenantId, doc_id: docId, scope, exp };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.unauthorizedWith('PREVIEW_TOKEN_INVALID', '预览链接无效或已过期');
  }
}

export function signedPreviewUrl(path: string, token: string): string {
  return `${path}?preview_token=${token}`;
}

export function contextualPreviewUrl(path: string, conversationId: string | null): string {
  return conversationId === null ? path : `${path}?conversation_id=${conversationId}`;
}
