// 移植自 apps/api-rs/src/api/document_jobs.rs —— 文档处理任务列表/详情
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import { requireTenantAdmin } from '../auth/permissions.ts';
import { toRfc3339 } from '../infra/time.ts';
import type { AppEnv } from '../http/types.ts';
import { requiredSql } from './documents_access.ts';
import { pathParam } from './documents_support.ts';

export interface JobListQuery {
  status: string | null;
  kb_id: string | null;
  batch_id: string | null;
  q: string | null;
  limit: number | null;
}

export interface DocumentJob {
  job_id: string;
  doc_id: string;
  upload_batch_id: string | null;
  kb_id: string;
  kb_name: string;
  file_name: string;
  file_type: string;
  file_size: number;
  uploaded_by: string | null;
  parse_status: string;
  job_status: string;
  current_stage: string;
  queue_position: number | null;
  stalled: boolean;
  attempt_count: number;
  max_attempts: number;
  quality_score: number | null;
  page_count: number | null;
  block_count: number | null;
  table_count: number | null;
  chunk_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface JobSummary {
  queued: number;
  processing: number;
  failed_24h: number;
  completed_24h: number;
  stalled: number;
}

export interface ProcessingEvent {
  id: string;
  stage: string;
  status: string;
  message: string;
  metrics: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export interface VectorJobDetail {
  id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  error_message: string | null;
  available_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobDetail {
  job: DocumentJob;
  events: ProcessingEvent[];
  vector_job: VectorJobDetail | null;
}

const JOB_LIST_WHERE = ` WHERE j.tenant_id = \$1
 AND (\$2::uuid IS NULL OR d.kb_id = \$2)
 AND (\$3::uuid IS NULL OR d.upload_batch_id = \$3)
 AND (\$4::text IS NULL OR \$4 = 'all' OR CASE
   WHEN j.status IN ('pending', 'ocr_queued') THEN 'queued'
   WHEN j.status = 'running' OR v.status IN ('pending', 'running') THEN 'processing'
   WHEN j.status = 'failed' OR v.status = 'failed' OR d.parse_status IN ('parse_failed', 'embedding_failed') THEN 'failed'
   WHEN d.parse_status = 'indexed' THEN 'completed' ELSE 'warning' END = \$4)
 AND (\$5::text IS NULL OR d.title ILIKE \$5 OR COALESCE(d.metadata->>'original_filename', d.storage_key) ILIKE \$5)
 ORDER BY CASE WHEN j.status = 'running' AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < NOW() - INTERVAL '10 minutes' THEN 0 WHEN j.status IN ('pending', 'ocr_queued', 'running') OR v.status IN ('pending', 'running') THEN 1 ELSE 2 END, j.created_at DESC LIMIT \$6`;

const JOB_SELECT_BASE = `SELECT j.parse_job_id AS job_id, d.id AS doc_id, d.upload_batch_id, d.kb_id, kb.name AS kb_name,
 COALESCE(d.metadata->>'original_filename', d.storage_key) AS file_name, d.file_type, d.file_size_bytes AS file_size,
 u.email AS uploaded_by, d.parse_status, j.status AS parse_job_status, v.status AS vector_status,
 CASE WHEN j.status IN ('pending', 'ocr_queued') THEN (SELECT COUNT(*) + 1 FROM document_parse_jobs q WHERE q.status IN ('pending', 'ocr_queued') AND q.created_at < j.created_at)
 ELSE NULL END AS queue_position,
 (j.status = 'running' AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < NOW() - INTERVAL '10 minutes') AS stalled,
 j.attempt_count, j.max_attempts, j.quality_score,
 COALESCE((j.parser_config->>'page_count')::int, NULL) AS page_count,
 COALESCE((j.parser_config->>'block_count')::int, NULL) AS block_count,
 COALESCE((j.parser_config->>'table_count')::int, NULL) AS table_count,
 d.chunk_count, j.error_code, COALESCE(j.error_message, v.error_message) AS error_message,
 j.created_at, j.started_at, j.completed_at, COALESCE(j.updated_at, d.updated_at) AS updated_at
 FROM document_parse_jobs j JOIN documents d ON d.id = j.doc_id JOIN knowledge_base kb ON kb.id = d.kb_id
 LEFT JOIN app_user u ON u.id = d.created_by
 LEFT JOIN LATERAL (SELECT status, error_message, completed_at FROM vector_jobs WHERE parse_job_id = j.parse_job_id ORDER BY created_at DESC LIMIT 1) v ON TRUE`;

/** Rust: display_status */
export function displayStatus(
  parseJob: string, vectorJob: string | null, document: string,
): [string, string] {
  if (parseJob === 'pending' || parseJob === 'ocr_queued') return ['queued', 'waiting_parse'];
  if (parseJob === 'running') {
    return ['processing', document === 'ocr_pending' ? 'ocr' : 'parsing'];
  }
  if (parseJob === 'failed' || vectorJob === 'failed'
    || document === 'parse_failed' || document === 'embedding_failed') {
    return ['failed', document === 'embedding_failed' ? 'embedding' : 'parsing'];
  }
  if (vectorJob === 'pending' || vectorJob === 'running') return ['processing', 'embedding'];
  if (document === 'indexed') return ['completed', 'indexed'];
  return ['warning', 'quality_review'];
}

function jobFromRow(row: Record<string, unknown>): DocumentJob {
  const parseJobStatus = String(row.parse_job_status);
  const vectorStatus = row.vector_status == null ? null : String(row.vector_status);
  const parseStatus = String(row.parse_status);
  const [jobStatus, currentStage] = displayStatus(parseJobStatus, vectorStatus, parseStatus);
  return {
    job_id: String(row.job_id),
    doc_id: String(row.doc_id),
    upload_batch_id: row.upload_batch_id == null ? null : String(row.upload_batch_id),
    kb_id: String(row.kb_id),
    kb_name: String(row.kb_name),
    file_name: String(row.file_name),
    file_type: String(row.file_type),
    file_size: Number(row.file_size),
    uploaded_by: row.uploaded_by == null ? null : String(row.uploaded_by),
    parse_status: parseStatus,
    job_status: jobStatus,
    current_stage: currentStage,
    queue_position: row.queue_position == null ? null : Number(row.queue_position),
    stalled: Boolean(row.stalled),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    quality_score: row.quality_score == null ? null : Number(row.quality_score),
    page_count: row.page_count == null ? null : Number(row.page_count),
    block_count: row.block_count == null ? null : Number(row.block_count),
    table_count: row.table_count == null ? null : Number(row.table_count),
    chunk_count: Number(row.chunk_count),
    error_code: row.error_code == null ? null : String(row.error_code),
    error_message: row.error_message == null ? null : String(row.error_message),
    created_at: toRfc3339(new Date(row.created_at as string | Date)),
    started_at: row.started_at == null ? null : toRfc3339(new Date(row.started_at as string | Date)),
    completed_at: row.completed_at == null ? null : toRfc3339(new Date(row.completed_at as string | Date)),
    updated_at: toRfc3339(new Date(row.updated_at as string | Date)),
  };
}

/** Rust: JobListQuery（UUID 解析失败时 axum 返回 400） */
function jobListQuery(c: Context<AppEnv>): JobListQuery {
  const uuidParams: Array<[string, string | null]> = [];
  for (const name of ['kb_id', 'batch_id']) {
    const raw = c.req.query(name);
    if (raw !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      throw AppError.badRequest('BAD_REQUEST', 'query 参数无效');
    }
    uuidParams.push([name, raw ?? null]);
  }
  const rawLimit = c.req.query('limit');
  let limit: number | null = null;
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isNaN(parsed)) throw AppError.badRequest('BAD_REQUEST', 'query 参数无效');
    limit = parsed;
  }
  return {
    status: c.req.query('status') ?? null,
    kb_id: uuidParams[0]?.[1] ?? null,
    batch_id: uuidParams[1]?.[1] ?? null,
    q: c.req.query('q') ?? null,
    limit,
  };
}

/** Rust: list_jobs */
export async function listJobs(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = requiredSql(state, '文档处理任务需要启用 PostgreSQL 数据库连接');
  const query = jobListQuery(c);

  const trimmed = query.q?.trim();
  const search = trimmed !== undefined && trimmed !== '' ? `%${trimmed}%` : null;
  const rawLimit = query.limit ?? 100;
  const limit = Math.min(200, Math.max(1, rawLimit));

  const rows = await sql.unsafe(JOB_SELECT_BASE + JOB_LIST_WHERE, [
    actor.tenant_id, query.kb_id, query.batch_id, query.status, search, limit,
  ]);
  const items = rows.map(jobFromRow);

  const summaryRows = await sql.unsafe(
    `SELECT
       COUNT(*) FILTER (WHERE j.status IN ('pending', 'ocr_queued')) AS queued,
       COUNT(*) FILTER (WHERE j.status = 'running' OR v.status IN ('pending', 'running')) AS processing,
       COUNT(*) FILTER (WHERE (j.status = 'failed' OR v.status = 'failed') AND COALESCE(j.completed_at, v.completed_at, j.updated_at) >= NOW() - INTERVAL '24 hours') AS failed_24h,
       COUNT(*) FILTER (WHERE d.parse_status = 'indexed' AND d.updated_at >= NOW() - INTERVAL '24 hours') AS completed_24h,
       COUNT(*) FILTER (WHERE j.status = 'running' AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < NOW() - INTERVAL '10 minutes') AS stalled
     FROM document_parse_jobs j
     JOIN documents d ON d.id = j.doc_id AND d.latest_parse_job_id = j.parse_job_id
     LEFT JOIN LATERAL (SELECT status, completed_at FROM vector_jobs WHERE parse_job_id = j.parse_job_id ORDER BY created_at DESC LIMIT 1) v ON TRUE
     WHERE j.tenant_id = \$1`,
    [actor.tenant_id],
  );
  const summaryRow = (summaryRows[0] ?? {}) as Record<string, unknown>;
  const summary: JobSummary = {
    queued: Number(summaryRow.queued ?? 0),
    processing: Number(summaryRow.processing ?? 0),
    failed_24h: Number(summaryRow.failed_24h ?? 0),
    completed_24h: Number(summaryRow.completed_24h ?? 0),
    stalled: Number(summaryRow.stalled ?? 0),
  };
  return c.json({ items, summary });
}

/** Rust: get_job */
export async function getJob(c: Context<AppEnv>): Promise<Response> {
  const state = c.get('appState');
  const actor = c.get('actor');
  requireTenantAdmin(actor);
  const sql = requiredSql(state, '文档处理任务需要启用 PostgreSQL 数据库连接');
  const jobId = pathParam(c, 'job_id');

  const rows = await sql.unsafe(
    `${JOB_SELECT_BASE} WHERE j.tenant_id = \$1 AND j.parse_job_id = \$2`,
    [actor.tenant_id, jobId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('DOCUMENT_JOB_NOT_FOUND', '文档处理任务不存在或无权限');
  }

  const eventRows = await sql.unsafe(
    `SELECT id, stage, status, message, metrics, error_code, error_message, created_at
     FROM document_processing_events WHERE tenant_id = \$1 AND parse_job_id = \$2 ORDER BY created_at, id`,
    [actor.tenant_id, jobId],
  );
  const events: ProcessingEvent[] = eventRows.map((eventRow) => ({
    id: String(eventRow.id),
    stage: String(eventRow.stage),
    status: String(eventRow.status),
    message: String(eventRow.message),
    metrics: eventRow.metrics ?? {},
    error_code: eventRow.error_code == null ? null : String(eventRow.error_code),
    error_message: eventRow.error_message == null ? null : String(eventRow.error_message),
    created_at: toRfc3339(new Date(eventRow.created_at as string | Date)),
  }));

  const vectorRows = await sql.unsafe(
    `SELECT id, status, attempt_count, max_attempts, error_message, available_at, started_at, completed_at
     FROM vector_jobs WHERE tenant_id = \$1 AND parse_job_id = \$2 ORDER BY created_at DESC LIMIT 1`,
    [actor.tenant_id, jobId],
  );
  const vectorRow = vectorRows[0];
  const vectorJob: VectorJobDetail | null = vectorRow === undefined ? null : {
    id: String(vectorRow.id),
    status: String(vectorRow.status),
    attempt_count: Number(vectorRow.attempt_count),
    max_attempts: Number(vectorRow.max_attempts),
    error_message: vectorRow.error_message == null ? null : String(vectorRow.error_message),
    available_at: toRfc3339(new Date(vectorRow.available_at as string | Date)),
    started_at: vectorRow.started_at == null ? null : toRfc3339(new Date(vectorRow.started_at as string | Date)),
    completed_at: vectorRow.completed_at == null ? null : toRfc3339(new Date(vectorRow.completed_at as string | Date)),
  };

  const body: JobDetail = { job: jobFromRow(row), events, vector_job: vectorJob };
  return c.json(body);
}