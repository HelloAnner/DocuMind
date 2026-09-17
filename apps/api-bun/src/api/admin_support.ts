// 移植自 apps/api-rs/src/api/admin.rs 的共享校验、行映射与默认配置
import type { Sql } from 'postgres';
import { AppError } from '../errors.ts';
import type { KnowledgeBaseSummary } from '../models/identity.ts';
import { toRfc3339 } from '../infra/time.ts';

export interface KnowledgeBaseUpsert {
  name: string;
  description?: string | null;
  status?: string | null;
  tags?: string[] | null;
}

export const CHUNKER_VERSION = 'documind-chunker@0.2.0';

// Rust document::ChunkConfig::default() 的默认值；api-bun 的 config.ts 暂未暴露 chunk 配置项。
export const DEFAULT_CHUNK_CONFIG = {
  target_chunk_tokens: 800,
  max_chunk_tokens: 1500,
  hard_split_tokens: 2000,
  min_chunk_tokens: 200,
  overlap_tokens: 200,
  max_table_rows_per_chunk: 50,
  max_table_token_per_chunk: 1200,
} as const;

export function normalizeKbName(value: string): string {
  const name = (value ?? '').trim();
  if (name.length === 0) {
    throw AppError.badRequest('KB_NAME_EMPTY', '知识库名称不能为空');
  }
  if ([...name].length > 128) {
    throw AppError.badRequest('KB_NAME_TOO_LONG', '知识库名称不能超过 128 个字符');
  }
  return name;
}

export function normalizeKbStatus(value?: string | null): string {
  const status = (value ?? 'active').trim();
  if (status === 'active' || status === 'disabled' || status === 'archived') return status;
  throw AppError.badRequest('KB_STATUS_INVALID', '知识库状态只能是 active / disabled / archived');
}

export function normalizeTags(values: string[]): string[] {
  const tags = values.map((tag) => (tag ?? '').trim()).filter((tag) => tag.length > 0).slice(0, 20);
  return [...new Set(tags)].sort();
}

export function providerName(baseUrl: string): string {
  const normalized = (baseUrl ?? '').toLowerCase();
  if (normalized.includes('dashscope') || normalized.includes('aliyuncs')) return 'DashScope';
  if (normalized.includes('openai')) return 'OpenAI';
  if (normalized.includes('deepseek')) return 'DeepSeek';
  return 'OpenAI-compatible';
}

export function kbSummaryFromRow(row: Record<string, unknown>): KnowledgeBaseSummary {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    status: String(row.status),
    tags: (row.tags as string[]) ?? [],
    doc_count: Number(row.doc_count ?? 0),
    chunk_count: Number(row.chunk_count ?? 0),
    query_count: Number(row.query_count ?? 0),
    updated_at: toRfc3339(new Date(row.updated_at as Date | string)),
  };
}

export function normalizeAclPermission(value: string): string {
  const permission = (value ?? '').trim();
  if (permission === 'read' || permission === 'write' || permission === 'manage') return permission;
  throw AppError.badRequest('ACL_PERMISSION_INVALID', '授权权限只能是 read / write / manage');
}

export function kbNotFound(): AppError {
  return AppError.notFound('KB_NOT_FOUND', '知识库不存在或无权限');
}

export async function ensureKbExists(
  sql: Sql, tenantId: string, kbId: string,
): Promise<void> {
  const rows = await sql`
    SELECT id FROM knowledge_base WHERE tenant_id = ${tenantId} AND id = ${kbId}
  `;
  if (rows.length === 0) throw kbNotFound();
}
