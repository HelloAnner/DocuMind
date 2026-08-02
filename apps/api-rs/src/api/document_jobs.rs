use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_tenant_admin, ActorExtractor};
use crate::error::AppError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/document-jobs", get(list_jobs))
        .route("/api/admin/document-jobs/:job_id", get(get_job))
}

#[derive(Debug, Deserialize)]
struct JobListQuery {
    status: Option<String>,
    kb_id: Option<Uuid>,
    batch_id: Option<Uuid>,
    q: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct JobListResponse {
    items: Vec<DocumentJob>,
    summary: JobSummary,
}

#[derive(Debug, Serialize, Default)]
struct JobSummary {
    queued: i64,
    processing: i64,
    failed_24h: i64,
    completed_24h: i64,
    stalled: i64,
}

#[derive(Debug, Serialize)]
struct DocumentJob {
    job_id: Uuid,
    doc_id: Uuid,
    upload_batch_id: Option<Uuid>,
    kb_id: Uuid,
    kb_name: String,
    file_name: String,
    file_type: String,
    file_size: i64,
    uploaded_by: Option<String>,
    parse_status: String,
    job_status: String,
    current_stage: String,
    queue_position: Option<i64>,
    stalled: bool,
    attempt_count: i32,
    max_attempts: i32,
    quality_score: Option<f64>,
    page_count: Option<i32>,
    block_count: Option<i32>,
    table_count: Option<i32>,
    chunk_count: i32,
    error_code: Option<String>,
    error_message: Option<String>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct ProcessingEvent {
    id: Uuid,
    stage: String,
    status: String,
    message: String,
    metrics: Value,
    error_code: Option<String>,
    error_message: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct VectorJobDetail {
    id: Uuid,
    status: String,
    attempt_count: i32,
    max_attempts: i32,
    error_message: Option<String>,
    available_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
struct JobDetail {
    job: DocumentJob,
    events: Vec<ProcessingEvent>,
    vector_job: Option<VectorJobDetail>,
}

async fn list_jobs(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Query(query): Query<JobListQuery>,
) -> Result<Json<JobListResponse>, AppError> {
    require_tenant_admin(&actor)?;
    let pool = state.db_pool.as_ref().ok_or_else(database_required)?;
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{q}%"));
    let list_sql = format!("{JOB_SELECT_BASE}{JOB_LIST_WHERE}");
    let rows = sqlx::query(&list_sql)
        .bind(actor.tenant_id)
        .bind(query.kb_id)
        .bind(query.batch_id)
        .bind(query.status.as_deref())
        .bind(search)
        .bind(query.limit.unwrap_or(100).clamp(1, 200))
        .fetch_all(pool)
        .await?;
    let items: Vec<_> = rows.into_iter().map(job_from_row).collect();
    let summary_row = sqlx::query(
        "SELECT
           COUNT(*) FILTER (WHERE j.status IN ('pending', 'ocr_queued')) AS queued,
           COUNT(*) FILTER (WHERE j.status = 'running' OR v.status IN ('pending', 'running')) AS processing,
           COUNT(*) FILTER (WHERE (j.status = 'failed' OR v.status = 'failed') AND COALESCE(j.completed_at, v.completed_at, j.updated_at) >= NOW() - INTERVAL '24 hours') AS failed_24h,
           COUNT(*) FILTER (WHERE d.parse_status = 'indexed' AND d.updated_at >= NOW() - INTERVAL '24 hours') AS completed_24h,
           COUNT(*) FILTER (WHERE j.status = 'running' AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < NOW() - INTERVAL '10 minutes') AS stalled
         FROM document_parse_jobs j
         JOIN documents d ON d.id = j.doc_id AND d.latest_parse_job_id = j.parse_job_id
         LEFT JOIN LATERAL (SELECT status, completed_at FROM vector_jobs WHERE parse_job_id = j.parse_job_id ORDER BY created_at DESC LIMIT 1) v ON TRUE
         WHERE j.tenant_id = $1"
    )
    .bind(actor.tenant_id)
    .fetch_one(pool)
    .await?;
    Ok(Json(JobListResponse {
        items,
        summary: JobSummary {
            queued: summary_row.get("queued"),
            processing: summary_row.get("processing"),
            failed_24h: summary_row.get("failed_24h"),
            completed_24h: summary_row.get("completed_24h"),
            stalled: summary_row.get("stalled"),
        },
    }))
}

async fn get_job(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(job_id): Path<Uuid>,
) -> Result<Json<JobDetail>, AppError> {
    require_tenant_admin(&actor)?;
    let pool = state.db_pool.as_ref().ok_or_else(database_required)?;
    let row = sqlx::query(&format!(
        "{JOB_SELECT_BASE} WHERE j.tenant_id = $1 AND j.parse_job_id = $2"
    ))
    .bind(actor.tenant_id)
    .bind(job_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound {
        code: "DOCUMENT_JOB_NOT_FOUND".into(),
        message: "文档处理任务不存在或无权限".into(),
    })?;
    let events = sqlx::query(
        "SELECT id, stage, status, message, metrics, error_code, error_message, created_at
         FROM document_processing_events WHERE tenant_id = $1 AND parse_job_id = $2 ORDER BY created_at, id"
    )
    .bind(actor.tenant_id)
    .bind(job_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| ProcessingEvent {
        id: row.get("id"), stage: row.get("stage"), status: row.get("status"), message: row.get("message"),
        metrics: row.get("metrics"), error_code: row.get("error_code"), error_message: row.get("error_message"), created_at: row.get("created_at"),
    }).collect();
    let vector_job = sqlx::query(
        "SELECT id, status, attempt_count, max_attempts, error_message, available_at, started_at, completed_at
         FROM vector_jobs WHERE tenant_id = $1 AND parse_job_id = $2 ORDER BY created_at DESC LIMIT 1"
    )
    .bind(actor.tenant_id)
    .bind(job_id)
    .fetch_optional(pool)
    .await?
    .map(|row| VectorJobDetail {
        id: row.get("id"), status: row.get("status"), attempt_count: row.get("attempt_count"), max_attempts: row.get("max_attempts"),
        error_message: row.get("error_message"), available_at: row.get("available_at"), started_at: row.get("started_at"), completed_at: row.get("completed_at"),
    });
    Ok(Json(JobDetail {
        job: job_from_row(row),
        events,
        vector_job,
    }))
}

const JOB_LIST_WHERE: &str = " WHERE j.tenant_id = $1
 AND ($2::uuid IS NULL OR d.kb_id = $2)
 AND ($3::uuid IS NULL OR d.upload_batch_id = $3)
 AND ($4::text IS NULL OR $4 = 'all' OR CASE
   WHEN j.status IN ('pending', 'ocr_queued') THEN 'queued'
   WHEN j.status = 'running' OR v.status IN ('pending', 'running') THEN 'processing'
   WHEN j.status = 'failed' OR v.status = 'failed' OR d.parse_status IN ('parse_failed', 'embedding_failed') THEN 'failed'
   WHEN d.parse_status = 'indexed' THEN 'completed' ELSE 'warning' END = $4)
 AND ($5::text IS NULL OR d.title ILIKE $5 OR COALESCE(d.metadata->>'original_filename', d.storage_key) ILIKE $5)
 ORDER BY CASE WHEN j.status = 'running' AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < NOW() - INTERVAL '10 minutes' THEN 0 WHEN j.status IN ('pending', 'ocr_queued', 'running') OR v.status IN ('pending', 'running') THEN 1 ELSE 2 END, j.created_at DESC LIMIT $6";

const JOB_SELECT_BASE: &str = "SELECT j.parse_job_id AS job_id, d.id AS doc_id, d.upload_batch_id, d.kb_id, kb.name AS kb_name,
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
 LEFT JOIN LATERAL (SELECT status, error_message, completed_at FROM vector_jobs WHERE parse_job_id = j.parse_job_id ORDER BY created_at DESC LIMIT 1) v ON TRUE";

fn job_from_row(row: sqlx::postgres::PgRow) -> DocumentJob {
    let parse_job_status: String = row.get("parse_job_status");
    let vector_status: Option<String> = row.get("vector_status");
    let parse_status: String = row.get("parse_status");
    let (job_status, current_stage) =
        display_status(&parse_job_status, vector_status.as_deref(), &parse_status);
    DocumentJob {
        job_id: row.get("job_id"),
        doc_id: row.get("doc_id"),
        upload_batch_id: row.get("upload_batch_id"),
        kb_id: row.get("kb_id"),
        kb_name: row.get("kb_name"),
        file_name: row.get("file_name"),
        file_type: row.get("file_type"),
        file_size: row.get("file_size"),
        uploaded_by: row.get("uploaded_by"),
        parse_status,
        job_status: job_status.into(),
        current_stage: current_stage.into(),
        queue_position: row.get("queue_position"),
        stalled: row.get("stalled"),
        attempt_count: row.get("attempt_count"),
        max_attempts: row.get("max_attempts"),
        quality_score: row.get("quality_score"),
        page_count: row.get("page_count"),
        block_count: row.get("block_count"),
        table_count: row.get("table_count"),
        chunk_count: row.get("chunk_count"),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
        created_at: row.get("created_at"),
        started_at: row.get("started_at"),
        completed_at: row.get("completed_at"),
        updated_at: row.get("updated_at"),
    }
}

fn display_status(
    parse_job: &str,
    vector_job: Option<&str>,
    document: &str,
) -> (&'static str, &'static str) {
    if matches!(parse_job, "pending" | "ocr_queued") {
        return ("queued", "waiting_parse");
    }
    if parse_job == "running" {
        return (
            "processing",
            if document == "ocr_pending" {
                "ocr"
            } else {
                "parsing"
            },
        );
    }
    if parse_job == "failed"
        || vector_job == Some("failed")
        || matches!(document, "parse_failed" | "embedding_failed")
    {
        return (
            "failed",
            if document == "embedding_failed" {
                "embedding"
            } else {
                "parsing"
            },
        );
    }
    if matches!(vector_job, Some("pending" | "running")) {
        return ("processing", "embedding");
    }
    if document == "indexed" {
        return ("completed", "indexed");
    }
    ("warning", "quality_review")
}

fn database_required() -> AppError {
    AppError::bad_request(
        "DATABASE_REQUIRED",
        "文档处理任务需要启用 PostgreSQL 数据库连接",
    )
}

#[cfg(test)]
mod tests {
    use super::display_status;

    #[test]
    fn maps_pipeline_states() {
        assert_eq!(
            display_status("pending", None, "uploaded"),
            ("queued", "waiting_parse")
        );
        assert_eq!(
            display_status("completed", Some("running"), "embedding"),
            ("processing", "embedding")
        );
        assert_eq!(
            display_status("completed", Some("completed"), "indexed"),
            ("completed", "indexed")
        );
    }
}
