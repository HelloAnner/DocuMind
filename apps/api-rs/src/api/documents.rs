use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;
use zip::ZipArchive;

use crate::auth::{require_kb_permission, require_permission, ActorExtractor};
use crate::error::AppError;
use crate::rag::embedding::{
    local_hash_embedding, LOCAL_HASH_EMBEDDING_DIM, LOCAL_HASH_EMBEDDING_MODEL,
};
use crate::state::AppState;

const PARSER_VERSION: &str = "documind-parser@0.2.0";
const PREVIEW_CHAR_LIMIT: usize = 60_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/knowledge-bases/:kb_id/documents",
            post(upload_document).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        .route("/api/admin/documents", get(list_documents))
        .route(
            "/api/admin/documents/:doc_id",
            get(get_document).delete(delete_document).post(reprocess_document),
        )
        .route("/api/admin/documents/:doc_id/original", get(download_original))
        .route("/api/admin/documents/:doc_id/move", post(move_document))
        .route("/api/admin/documents/:doc_id/retry", post(retry_parse))
        .route("/api/admin/documents/retry", post(retry_documents))
}

// ---------------------------------------------------------------------------
// Cloud-side response / request types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct UploadDocumentResponse {
    document_id: Uuid,
    parse_job_id: Uuid,
    title: String,
    file_type: String,
    parse_status: String,
    block_count: usize,
    table_count: usize,
    chunk_count: usize,
    storage_key: String,
}

#[derive(Debug, Serialize)]
struct DeleteDocumentResponse {
    document_id: Uuid,
    status: String,
}

#[derive(Debug, Serialize)]
struct ReprocessDocumentResponse {
    document_id: Uuid,
    parse_job_id: Uuid,
    parse_status: String,
    parse_version: i32,
    block_count: usize,
    table_count: usize,
    chunk_count: usize,
    reused_existing_parse: bool,
}

// ---------------------------------------------------------------------------
// Local-only response / request types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DocumentListQuery {
    kb_id: Option<Uuid>,
    status: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct MoveDocumentRequest {
    kb_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct RetryDocumentsRequest {
    doc_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
struct DocumentSummary {
    doc_id: Uuid,
    kb_id: Uuid,
    kb_name: String,
    title: String,
    file_name: String,
    file_type: String,
    mime_type: String,
    file_size: i64,
    file_sha256: String,
    parse_status: String,
    parse_version: i32,
    latest_parse_job_id: Option<Uuid>,
    quality_score: Option<f64>,
    chunk_count: i32,
    table_count: i32,
    page_count: Option<i32>,
    uploaded_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct DocumentDetail {
    document: DocumentSummary,
    latest_job: Option<ParseJobSummary>,
    preview: DocumentPreview,
    blocks: Vec<BlockSummary>,
    chunks: Vec<ChunkSummary>,
    tables: Vec<TableSummary>,
}

#[derive(Debug, Serialize)]
struct DocumentPreview {
    mode: String,
    title: String,
    text: String,
    truncated: bool,
    source: String,
    char_count: i32,
}

#[derive(Debug, Serialize)]
struct ParseJobSummary {
    parse_job_id: Uuid,
    status: String,
    parser_version: String,
    quality_score: Option<f64>,
    page_count: Option<i32>,
    block_count: Option<i32>,
    table_count: Option<i32>,
    char_count: Option<i32>,
    warnings: Value,
    error_code: Option<String>,
    error_message: Option<String>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct BlockSummary {
    block_id: Uuid,
    block_index: i32,
    block_type: String,
    text: String,
    heading_level: Option<i32>,
    heading_path: Vec<String>,
    page_start: Option<i32>,
    page_end: Option<i32>,
    slide_index: Option<i32>,
    table_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct ChunkSummary {
    chunk_id: Uuid,
    chunk_index: i32,
    source_type: String,
    content: String,
    heading_path: Vec<String>,
    page_start: Option<i32>,
    page_end: Option<i32>,
    slide_start: Option<i32>,
    slide_end: Option<i32>,
    token_count: i32,
}

#[derive(Debug, Serialize)]
struct TableSummary {
    table_id: Uuid,
    table_index: i32,
    title: Option<String>,
    row_count: i32,
    col_count: i32,
    headers: Value,
    markdown: String,
    quality: Value,
}

// ---------------------------------------------------------------------------
// Parsing pipeline internal types (cloud base)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ParsedBlock {
    block_type: String,
    heading_path: Vec<String>,
    page_range: Vec<i32>,
    content: String,
    metadata: serde_json::Value,
}

#[derive(Debug)]
struct ParsedDocument {
    blocks: Vec<ParsedBlock>,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct ChunkDraft {
    content: String,
    heading_path: Vec<String>,
    page_range: Vec<i32>,
    token_count: i32,
    metadata: serde_json::Value,
}

struct UploadedFile {
    title: String,
    file_name: String,
    bytes: Vec<u8>,
}

struct ParseArtifacts {
    parsed: ParsedDocument,
    chunks: Vec<ChunkDraft>,
    parser_config: serde_json::Value,
    parse_identity: String,
    table_count: usize,
    quality_score: f64,
    parse_status: String,
}

#[derive(Debug)]
struct DocumentRecord {
    id: Uuid,
    tenant_id: Uuid,
    kb_id: Uuid,
    file_type: String,
    storage_key: String,
    file_sha256: String,
    parse_version: i32,
}

#[derive(Debug, Clone, Copy)]
struct ParseWriteScope {
    tenant_id: Uuid,
    kb_id: Uuid,
    doc_id: Uuid,
    parse_job_id: Uuid,
    parse_version: i32,
}

struct ParseJobTask {
    tenant_id: Uuid,
    kb_id: Uuid,
    doc_id: Uuid,
    parse_job_id: Uuid,
    parse_version: i32,
    file_type: String,
    file_sha256: String,
    bytes: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn upload_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(kb_id): AxumPath<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<UploadDocumentResponse>, AppError> {
    require_permission(&actor, "document.upload")?;
    require_kb_permission(&actor, kb_id, "write")?;

    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档上传需要启用 PostgreSQL 数据库连接",
        )
    })?;

    ensure_kb_exists(pool, actor.tenant_id, kb_id).await?;

    let uploaded = read_multipart_file(&mut multipart).await?;
    let file_type = detect_file_type(&uploaded.file_name, &uploaded.bytes)?;
    let file_sha256 = sha256_hex(&uploaded.bytes);
    let doc_id = Uuid::new_v4();
    let parse_job_id = Uuid::new_v4();
    let storage_key = format!(
        "tenants/{}/knowledge-bases/{}/documents/{}/original/{}.{}",
        actor.tenant_id, kb_id, doc_id, file_sha256, file_type
    );
    let parser_config = current_parser_config();
    let parse_identity = parse_identity_for(&file_sha256, &parser_config);

    state.storage.put(&storage_key, &uploaded.bytes).await?;

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO documents (
            id, tenant_id, kb_id, title, file_type, file_size_bytes, storage_key,
            file_sha256, parse_status, parse_version, chunk_count, metadata, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12)",
    )
    .bind(doc_id)
    .bind(actor.tenant_id)
    .bind(kb_id)
    .bind(&uploaded.title)
    .bind(&file_type)
    .bind(uploaded.bytes.len() as i64)
    .bind(&storage_key)
    .bind(&file_sha256)
    .bind("uploaded")
    .bind(0_i32)
    .bind(json!({
        "original_filename": uploaded.file_name,
        "active_parse_job_id": parse_job_id,
    }))
    .bind(actor.user_id)
    .execute(&mut *tx)
    .await?;

    insert_pending_parse_job(
        &mut tx,
        ParseWriteScope {
            tenant_id: actor.tenant_id,
            kb_id,
            doc_id,
            parse_job_id,
            parse_version: 1,
        },
        parser_config.clone(),
        parse_identity.clone(),
    )
    .await?;

    sqlx::query(
        "UPDATE documents
         SET latest_parse_job_id = $1, updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(parse_job_id)
    .bind(actor.tenant_id)
    .bind(doc_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    spawn_parse_job(
        pool.clone(),
        ParseJobTask {
            tenant_id: actor.tenant_id,
            kb_id,
            doc_id,
            parse_job_id,
            parse_version: 1,
            file_type: file_type.clone(),
            file_sha256,
            bytes: uploaded.bytes,
        },
    );

    Ok(Json(UploadDocumentResponse {
        document_id: doc_id,
        parse_job_id,
        title: uploaded.title,
        file_type,
        parse_status: "uploaded".to_string(),
        block_count: 0,
        table_count: 0,
        chunk_count: 0,
        storage_key,
    }))
}

async fn delete_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<DeleteDocumentResponse>, AppError> {
    require_permission(&actor, "document.delete")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档删除需要启用 PostgreSQL 数据库连接",
        )
    })?;

    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    require_kb_permission(&actor, doc.kb_id, "write")?;

    sqlx::query("DELETE FROM documents WHERE tenant_id = $1 AND id = $2")
        .bind(actor.tenant_id)
        .bind(doc_id)
        .execute(pool)
        .await?;

    let _ = state.storage.delete(&doc.storage_key).await;

    Ok(Json(DeleteDocumentResponse {
        document_id: doc_id,
        status: "deleted".to_string(),
    }))
}

async fn reprocess_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<ReprocessDocumentResponse>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let resp = reprocess_or_retry_document(&state, &actor, doc_id, false).await?;
    Ok(Json(resp))
}

async fn retry_parse(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<DocumentSummary>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let _ = reprocess_or_retry_document(&state, &actor, doc_id, true).await?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档查询需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let summary = fetch_document_summary(pool, actor.tenant_id, doc_id).await?;
    Ok(Json(summary))
}

async fn retry_documents(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<RetryDocumentsRequest>,
) -> Result<Json<Value>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    if req.doc_ids.is_empty() {
        return Err(AppError::bad_request(
            "DOC_IDS_EMPTY",
            "请选择要重试的文档",
        ));
    }
    if req.doc_ids.len() > 50 {
        return Err(AppError::bad_request(
            "DOC_IDS_TOO_MANY",
            "一次最多重试 50 个文档",
        ));
    }

    let mut retried = 0usize;
    for doc_id in req.doc_ids {
        reprocess_or_retry_document(&state, &actor, doc_id, true).await?;
        retried += 1;
    }
    Ok(Json(json!({ "retried": retried })))
}

async fn list_documents(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Query(query): Query<DocumentListQuery>,
) -> Result<Json<Vec<DocumentSummary>>, AppError> {
    require_permission(&actor, "document.upload")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档列表查询需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let search = query
        .q
        .as_ref()
        .map(|q| q.trim())
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{q}%"));
    let limit = query.limit.unwrap_or(200).clamp(1, 200);

    let rows = sqlx::query(
        r#"
        SELECT d.id AS doc_id, d.kb_id, kb.name AS kb_name, d.title,
               COALESCE(d.metadata->>'original_filename', d.storage_key) AS file_name,
               d.file_type,
               'application/octet-stream' AS mime_type,
               d.file_size_bytes AS file_size,
               COALESCE(d.file_sha256, '') AS file_sha256,
               d.parse_status, d.parse_version,
               d.latest_parse_job_id, j.quality_score, d.chunk_count,
               0 AS table_count,
               NULL::int AS page_count,
               d.created_at AS uploaded_at, d.updated_at
        FROM documents d
        JOIN knowledge_base kb ON kb.id = d.kb_id
        LEFT JOIN document_parse_jobs j ON j.parse_job_id = d.latest_parse_job_id
        WHERE d.tenant_id = $1
          AND ($2::uuid IS NULL OR d.kb_id = $2)
          AND ($3::text IS NULL OR $3 = 'all' OR d.parse_status = $3)
          AND ($4::text IS NULL OR d.title ILIKE $4 OR COALESCE(d.metadata->>'original_filename', d.storage_key) ILIKE $4)
        ORDER BY d.updated_at DESC
        LIMIT $5
        "#,
    )
    .bind(actor.tenant_id)
    .bind(query.kb_id)
    .bind(query.status)
    .bind(search)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(Json(
        rows.into_iter().map(document_summary_from_row).collect(),
    ))
}

async fn get_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<DocumentDetail>, AppError> {
    require_permission(&actor, "document.upload")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档详情查询需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let document = fetch_document_summary(pool, actor.tenant_id, doc_id).await?;
    let latest_job = if let Some(job_id) = document.latest_parse_job_id {
        fetch_parse_job(pool, job_id).await?
    } else {
        None
    };
    let blocks = fetch_blocks(pool, doc_id, document.latest_parse_job_id).await?;
    let chunks = fetch_chunks(pool, doc_id, document.latest_parse_job_id).await?;
    let tables = fetch_tables(pool, doc_id, document.latest_parse_job_id).await?;
    let preview = render_document_preview(&document, latest_job.as_ref(), &blocks);
    Ok(Json(DocumentDetail {
        document,
        latest_job,
        preview,
        blocks,
        chunks,
        tables,
    }))
}

async fn move_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
    Json(req): Json<MoveDocumentRequest>,
) -> Result<Json<DocumentSummary>, AppError> {
    require_permission(&actor, "document.upload")?;
    if !actor.allowed_kb_ids.contains(&req.kb_id) && !actor.has_permission("kb.manage") {
        return Err(AppError::kb_scope_denied());
    }
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档移动需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        r#"
        UPDATE documents
        SET kb_id = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
          AND EXISTS (SELECT 1 FROM knowledge_base WHERE tenant_id = $1 AND id = $3)
        "#,
    )
    .bind(actor.tenant_id)
    .bind(doc_id)
    .bind(req.kb_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound {
            code: "DOCUMENT_NOT_FOUND".to_string(),
            message: "文档或目标知识库不存在".to_string(),
        });
    }
    sqlx::query("UPDATE chunks SET kb_id = $2 WHERE doc_id = $1")
        .bind(doc_id)
        .bind(req.kb_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(fetch_document_summary(pool, actor.tenant_id, doc_id).await?))
}

async fn download_original(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Response, AppError> {
    require_permission(&actor, "document.upload")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档下载需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let row = sqlx::query(
        "SELECT COALESCE(metadata->>'original_filename', storage_key) AS file_name, storage_key FROM documents WHERE tenant_id = $1 AND id = $2",
    )
    .bind(actor.tenant_id)
    .bind(doc_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound {
        code: "DOCUMENT_NOT_FOUND".to_string(),
        message: "文档不存在或无权限".to_string(),
    })?;
    let file_name: String = row.get("file_name");
    let storage_key: String = row.get("storage_key");
    let bytes = state.storage.get(&storage_key).await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"{}\"",
            sanitize_file_name(&file_name)
        ))
        .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    Ok((StatusCode::OK, headers, bytes).into_response())
}

// ---------------------------------------------------------------------------
// Shared reprocess / retry logic
// ---------------------------------------------------------------------------

async fn reprocess_or_retry_document(
    state: &AppState,
    actor: &crate::models::identity::CurrentActor,
    doc_id: Uuid,
    force: bool,
) -> Result<ReprocessDocumentResponse, AppError> {
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档重解析需要启用 PostgreSQL 数据库连接",
        )
    })?;

    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    require_kb_permission(actor, doc.kb_id, "write")?;

    let bytes = state.storage.get(&doc.storage_key).await.map_err(|e| {
        AppError::bad_request(
            "ORIGINAL_FILE_MISSING",
            format!("无法读取原始文件 {}: {e}", doc.storage_key),
        )
    })?;

    let parser_config = current_parser_config();
    let parse_identity = parse_identity_for(&doc.file_sha256, &parser_config);
    let new_parse_version = doc.parse_version + 1;

    if !force {
        if let Some((parse_job_id, chunk_count, parse_status)) =
            find_completed_parse_by_identity(pool, doc.id, &parse_identity).await?
        {
            sqlx::query(
                "UPDATE documents
                 SET latest_parse_job_id = $1,
                     parse_status = $2,
                     parse_version = $3,
                     chunk_count = $4,
                     updated_at = NOW()
                 WHERE tenant_id = $5 AND id = $6",
            )
            .bind(parse_job_id)
            .bind(&parse_status)
            .bind(new_parse_version)
            .bind(chunk_count)
            .bind(actor.tenant_id)
            .bind(doc.id)
            .execute(pool)
            .await?;

            return Ok(ReprocessDocumentResponse {
                document_id: doc.id,
                parse_job_id,
                parse_status,
                parse_version: new_parse_version,
                chunk_count: chunk_count as usize,
                block_count: 0,
                table_count: 0,
                reused_existing_parse: true,
            });
        }
    }

    let parse_job_id = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    insert_pending_parse_job(
        &mut tx,
        ParseWriteScope {
            tenant_id: doc.tenant_id,
            kb_id: doc.kb_id,
            doc_id: doc.id,
            parse_job_id,
            parse_version: new_parse_version,
        },
        parser_config,
        parse_identity,
    )
    .await?;
    tx.commit().await?;

    spawn_parse_job(
        pool.clone(),
        ParseJobTask {
            tenant_id: doc.tenant_id,
            kb_id: doc.kb_id,
            doc_id: doc.id,
            parse_job_id,
            parse_version: new_parse_version,
            file_type: doc.file_type.clone(),
            file_sha256: doc.file_sha256,
            bytes,
        },
    );

    Ok(ReprocessDocumentResponse {
        document_id: doc.id,
        parse_job_id,
        parse_status: "uploaded".to_string(),
        parse_version: new_parse_version,
        block_count: 0,
        table_count: 0,
        chunk_count: 0,
        reused_existing_parse: false,
    })
}

// ---------------------------------------------------------------------------
// Cloud-side persistence helpers
// ---------------------------------------------------------------------------

async fn ensure_kb_exists(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    kb_id: Uuid,
) -> Result<(), AppError> {
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM knowledge_base WHERE tenant_id = $1 AND id = $2 AND status = 'active'",
    )
    .bind(tenant_id)
    .bind(kb_id)
    .fetch_optional(pool)
    .await?;

    if exists.is_some() {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "KNOWLEDGE_BASE_NOT_FOUND",
            "知识库不存在或不可用",
        ))
    }
}

async fn fetch_document(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    doc_id: Uuid,
) -> Result<DocumentRecord, AppError> {
    let row = sqlx::query(
        "SELECT id, tenant_id, kb_id, file_type, storage_key, file_sha256, parse_version
         FROM documents
         WHERE tenant_id = $1 AND id = $2",
    )
    .bind(tenant_id)
    .bind(doc_id)
    .fetch_optional(pool)
    .await?;

    let row = row.ok_or_else(|| AppError::NotFound {
        code: "DOCUMENT_NOT_FOUND".to_string(),
        message: "文档不存在或无权限".to_string(),
    })?;

    Ok(DocumentRecord {
        id: row.get("id"),
        tenant_id: row.get("tenant_id"),
        kb_id: row.get("kb_id"),
        file_type: row.get("file_type"),
        storage_key: row.get("storage_key"),
        file_sha256: row.get("file_sha256"),
        parse_version: row.get("parse_version"),
    })
}

async fn find_completed_parse_by_identity(
    pool: &sqlx::PgPool,
    doc_id: Uuid,
    parse_identity: &str,
) -> Result<Option<(Uuid, i32, String)>, AppError> {
    let row = sqlx::query(
        "SELECT j.parse_job_id,
                COUNT(c.id)::int AS chunk_count,
                COALESCE(j.parser_config->>'parse_status', 'indexed') AS parse_status
         FROM document_parse_jobs j
         LEFT JOIN chunks c ON c.parse_job_id = j.parse_job_id
         WHERE j.doc_id = $1
           AND j.parse_identity = $2
           AND j.status = 'completed'
         GROUP BY j.parse_job_id, j.parser_config
         ORDER BY j.completed_at DESC NULLS LAST
         LIMIT 1",
    )
    .bind(doc_id)
    .bind(parse_identity)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| {
        (
            row.get("parse_job_id"),
            row.get("chunk_count"),
            row.get("parse_status"),
        )
    }))
}

async fn insert_pending_parse_job(
    tx: &mut Transaction<'_, Postgres>,
    scope: ParseWriteScope,
    parser_config: serde_json::Value,
    parse_identity: String,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO document_parse_jobs (
            parse_job_id, tenant_id, kb_id, doc_id, parser_version, parser_config,
            parse_identity, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')",
    )
    .bind(scope.parse_job_id)
    .bind(scope.tenant_id)
    .bind(scope.kb_id)
    .bind(scope.doc_id)
    .bind(PARSER_VERSION)
    .bind(parser_config)
    .bind(parse_identity)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "UPDATE documents
         SET latest_parse_job_id = $1,
             parse_status = 'uploaded',
             parse_version = $2,
             chunk_count = 0,
             metadata = metadata || $3,
             updated_at = NOW()
         WHERE tenant_id = $4 AND id = $5",
    )
    .bind(scope.parse_job_id)
    .bind(scope.parse_version)
    .bind(json!({
        "active_parse_job_id": scope.parse_job_id,
        "parse_progress": 10,
    }))
    .bind(scope.tenant_id)
    .bind(scope.doc_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

fn spawn_parse_job(pool: sqlx::PgPool, task: ParseJobTask) {
    tokio::spawn(async move {
        if let Err(err) = run_parse_job(pool.clone(), task).await {
            eprintln!("document parse job failed to update state: {err:#?}");
        }
    });
}

async fn run_parse_job(pool: sqlx::PgPool, task: ParseJobTask) -> Result<(), AppError> {
    mark_parse_job_running(&pool, &task).await?;

    match build_parse_artifacts(&task.file_type, &task.file_sha256, &task.bytes) {
        Ok(artifacts) => {
            let mut tx = pool.begin().await?;
            insert_parse_outputs(
                &mut tx,
                ParseWriteScope {
                    tenant_id: task.tenant_id,
                    kb_id: task.kb_id,
                    doc_id: task.doc_id,
                    parse_job_id: task.parse_job_id,
                    parse_version: task.parse_version,
                },
                &task.file_type,
                &artifacts,
            )
            .await?;
            tx.commit().await?;
            Ok(())
        }
        Err(err) => {
            mark_parse_job_failed(&pool, &task, &err).await?;
            Ok(())
        }
    }
}

async fn mark_parse_job_running(pool: &sqlx::PgPool, task: &ParseJobTask) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE document_parse_jobs
         SET status = 'running',
             started_at = COALESCE(started_at, NOW())
         WHERE tenant_id = $1 AND doc_id = $2 AND parse_job_id = $3",
    )
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .bind(task.parse_job_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE documents
         SET parse_status = 'parsing',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(json!({
        "active_parse_job_id": task.parse_job_id,
        "parse_progress": 30,
    }))
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

async fn mark_parse_job_failed(
    pool: &sqlx::PgPool,
    task: &ParseJobTask,
    err: &AppError,
) -> Result<(), AppError> {
    let (error_code, error_message) = app_error_details(err);
    let mut tx = pool.begin().await?;

    sqlx::query(
        "UPDATE document_parse_jobs
         SET status = 'failed',
             error_code = $1,
             error_message = $2,
             completed_at = NOW()
         WHERE tenant_id = $3 AND doc_id = $4 AND parse_job_id = $5",
    )
    .bind(&error_code)
    .bind(&error_message)
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .bind(task.parse_job_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE documents
         SET parse_status = 'parse_failed',
             chunk_count = 0,
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(json!({
        "active_parse_job_id": task.parse_job_id,
        "parse_progress": 100,
        "error_code": error_code,
        "error_message": error_message,
    }))
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

async fn insert_parse_outputs(
    tx: &mut Transaction<'_, Postgres>,
    scope: ParseWriteScope,
    file_type: &str,
    artifacts: &ParseArtifacts,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO document_parse_jobs (
            parse_job_id, tenant_id, kb_id, doc_id, parser_version, parser_config,
            parse_identity, status, quality_score, started_at, completed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, NOW(), NOW())
         ON CONFLICT (parse_job_id) DO UPDATE
         SET parser_config = EXCLUDED.parser_config,
             parse_identity = EXCLUDED.parse_identity,
             status = 'completed',
             error_code = NULL,
             error_message = NULL,
             quality_score = EXCLUDED.quality_score,
             started_at = COALESCE(document_parse_jobs.started_at, NOW()),
             completed_at = NOW()",
    )
    .bind(scope.parse_job_id)
    .bind(scope.tenant_id)
    .bind(scope.kb_id)
    .bind(scope.doc_id)
    .bind(PARSER_VERSION)
    .bind(artifacts.parser_config.clone())
    .bind(&artifacts.parse_identity)
    .bind(artifacts.quality_score)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "INSERT INTO document_parse_results (parse_job_id, doc_id, parsed_json)
         VALUES ($1, $2, $3)",
    )
    .bind(scope.parse_job_id)
    .bind(scope.doc_id)
    .bind(json!({
        "parser_version": PARSER_VERSION,
        "block_count": artifacts.parsed.blocks.len(),
        "table_count": artifacts.table_count,
        "chunk_count": artifacts.chunks.len(),
        "file_type": file_type,
    }))
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "UPDATE documents
         SET latest_parse_job_id = $1,
             parse_status = $2,
             parse_version = $3,
             chunk_count = $4,
             metadata = metadata || $5,
             updated_at = NOW()
         WHERE id = $6",
    )
    .bind(scope.parse_job_id)
    .bind(&artifacts.parse_status)
    .bind(scope.parse_version)
    .bind(artifacts.chunks.len() as i32)
    .bind(json!({
        "quality_score": artifacts.quality_score,
        "warnings": artifacts.parsed.warnings.clone(),
    }))
    .bind(scope.doc_id)
    .execute(&mut **tx)
    .await?;

    for (index, block) in artifacts.parsed.blocks.iter().enumerate() {
        sqlx::query(
            "INSERT INTO document_blocks (
                tenant_id, kb_id, doc_id, parse_job_id, block_index, block_type,
                heading_path, page_range, content, metadata
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(scope.parse_job_id)
        .bind(index as i32 + 1)
        .bind(&block.block_type)
        .bind(&block.heading_path)
        .bind(&block.page_range)
        .bind(&block.content)
        .bind(block.metadata.clone())
        .execute(&mut **tx)
        .await?;

        if block.block_type == "table" {
            sqlx::query(
                "INSERT INTO document_tables (
                    tenant_id, kb_id, doc_id, parse_job_id, table_index,
                    heading_path, page_range, markdown, cells, metadata
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]', $9)",
            )
            .bind(scope.tenant_id)
            .bind(scope.kb_id)
            .bind(scope.doc_id)
            .bind(scope.parse_job_id)
            .bind(index as i32 + 1)
            .bind(&block.heading_path)
            .bind(&block.page_range)
            .bind(&block.content)
            .bind(block.metadata.clone())
            .execute(&mut **tx)
            .await?;
        }
    }

    for (index, chunk) in artifacts.chunks.iter().enumerate() {
        let chunk_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO chunks (
                id, tenant_id, kb_id, doc_id, parse_job_id, chunk_index,
                content, heading_path, page_range, token_count, metadata
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(chunk_id)
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(scope.parse_job_id)
        .bind(index as i32 + 1)
        .bind(&chunk.content)
        .bind(&chunk.heading_path)
        .bind(&chunk.page_range)
        .bind(chunk.token_count)
        .bind(chunk.metadata.clone())
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "INSERT INTO chunk_embeddings (
                tenant_id, kb_id, doc_id, chunk_id, embedding_model, embedding_dim,
                embedding_vector, content_hash, status, embedded_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', NOW())",
        )
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(chunk_id)
        .bind(LOCAL_HASH_EMBEDDING_MODEL)
        .bind(LOCAL_HASH_EMBEDDING_DIM as i32)
        .bind(json!(local_hash_embedding(&chunk.content)))
        .bind(sha256_hex(chunk.content.as_bytes()))
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Local-only read helpers (mapped onto the cloud-side schema)
// ---------------------------------------------------------------------------

async fn fetch_document_summary(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    doc_id: Uuid,
) -> Result<DocumentSummary, AppError> {
    let row = sqlx::query(
        r#"
        SELECT d.id AS doc_id, d.kb_id, kb.name AS kb_name, d.title,
               COALESCE(d.metadata->>'original_filename', d.storage_key) AS file_name,
               d.file_type,
               'application/octet-stream' AS mime_type,
               d.file_size_bytes AS file_size,
               COALESCE(d.file_sha256, '') AS file_sha256,
               d.parse_status, d.parse_version,
               d.latest_parse_job_id, j.quality_score, d.chunk_count,
               0 AS table_count,
               NULL::int AS page_count,
               d.created_at AS uploaded_at, d.updated_at
        FROM documents d
        JOIN knowledge_base kb ON kb.id = d.kb_id
        LEFT JOIN document_parse_jobs j ON j.parse_job_id = d.latest_parse_job_id
        WHERE d.tenant_id = $1 AND d.id = $2
        "#,
    )
    .bind(tenant_id)
    .bind(doc_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound {
        code: "DOCUMENT_NOT_FOUND".to_string(),
        message: "文档不存在或无权限".to_string(),
    })?;
    Ok(document_summary_from_row(row))
}

fn document_summary_from_row(row: sqlx::postgres::PgRow) -> DocumentSummary {
    DocumentSummary {
        doc_id: row.get("doc_id"),
        kb_id: row.get("kb_id"),
        kb_name: row.get("kb_name"),
        title: row.get("title"),
        file_name: row.get("file_name"),
        file_type: row.get("file_type"),
        mime_type: row.get("mime_type"),
        file_size: row.get("file_size"),
        file_sha256: row.get("file_sha256"),
        parse_status: row.get("parse_status"),
        parse_version: row.get("parse_version"),
        latest_parse_job_id: row.get("latest_parse_job_id"),
        quality_score: row.get("quality_score"),
        chunk_count: row.get("chunk_count"),
        table_count: row.get("table_count"),
        page_count: row.get("page_count"),
        uploaded_at: row.get("uploaded_at"),
        updated_at: row.get("updated_at"),
    }
}

async fn fetch_parse_job(
    pool: &sqlx::PgPool,
    parse_job_id: Uuid,
) -> Result<Option<ParseJobSummary>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT parse_job_id, status, parser_version, quality_score,
               NULL::int AS page_count,
               NULL::int AS block_count,
               NULL::int AS table_count,
               NULL::int AS char_count,
               '{}'::jsonb AS warnings,
               error_code, error_message, started_at,
               completed_at AS finished_at, created_at
        FROM document_parse_jobs
        WHERE parse_job_id = $1
        "#,
    )
    .bind(parse_job_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| ParseJobSummary {
        parse_job_id: row.get("parse_job_id"),
        status: row.get("status"),
        parser_version: row.get("parser_version"),
        quality_score: row.get("quality_score"),
        page_count: row.get("page_count"),
        block_count: row.get("block_count"),
        table_count: row.get("table_count"),
        char_count: row.get("char_count"),
        warnings: row.get("warnings"),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
        started_at: row.get("started_at"),
        finished_at: row.get("finished_at"),
        created_at: row.get("created_at"),
    }))
}

async fn fetch_blocks(
    pool: &sqlx::PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
) -> Result<Vec<BlockSummary>, AppError> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(vec![]);
    };
    let rows = sqlx::query(
        r#"
        SELECT id AS block_id, block_index, block_type, content AS text,
               heading_path,
               (metadata->>'heading_level')::int AS heading_level,
               page_range,
               (metadata->>'slide')::int AS slide_index,
               (metadata->>'table_id')::uuid AS table_id
        FROM document_blocks
        WHERE doc_id = $1 AND parse_job_id = $2
        ORDER BY block_index
        LIMIT 300
        "#,
    )
    .bind(doc_id)
    .bind(parse_job_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let page_range: Vec<i32> = row.get("page_range");
            BlockSummary {
                block_id: row.get("block_id"),
                block_index: row.get("block_index"),
                block_type: row.get("block_type"),
                text: row.get("text"),
                heading_level: row.get("heading_level"),
                heading_path: row.get("heading_path"),
                page_start: page_range.first().copied(),
                page_end: page_range.last().copied(),
                slide_index: row.get("slide_index"),
                table_id: row.get("table_id"),
            }
        })
        .collect())
}

async fn fetch_chunks(
    pool: &sqlx::PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
) -> Result<Vec<ChunkSummary>, AppError> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(vec![]);
    };
    let rows = sqlx::query(
        r#"
        SELECT id AS chunk_id, chunk_index, content, heading_path,
               page_range, token_count, metadata
        FROM chunks
        WHERE doc_id = $1 AND parse_job_id = $2
        ORDER BY chunk_index
        LIMIT 200
        "#,
    )
    .bind(doc_id)
    .bind(parse_job_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let page_range: Vec<i32> = row.get("page_range");
            let metadata: Value = row.get("metadata");
            let slide = metadata
                .get("slide")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);
            ChunkSummary {
                chunk_id: row.get("chunk_id"),
                chunk_index: row.get("chunk_index"),
                source_type: metadata
                    .get("block_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("paragraph")
                    .to_string(),
                content: row.get("content"),
                heading_path: row.get("heading_path"),
                page_start: page_range.first().copied(),
                page_end: page_range.last().copied(),
                slide_start: slide,
                slide_end: slide,
                token_count: row.get("token_count"),
            }
        })
        .collect())
}

async fn fetch_tables(
    pool: &sqlx::PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
) -> Result<Vec<TableSummary>, AppError> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(vec![]);
    };
    let rows = sqlx::query(
        r#"
        SELECT id AS table_id, table_index,
               COALESCE(metadata->>'title', '') AS title,
               markdown, cells, metadata
        FROM document_tables
        WHERE doc_id = $1 AND parse_job_id = $2
        ORDER BY table_index
        LIMIT 100
        "#,
    )
    .bind(doc_id)
    .bind(parse_job_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let cells: Value = row.get("cells");
            let metadata: Value = row.get("metadata");
            let row_count = cells.as_array().map(|a| a.len() as i32).unwrap_or(0);
            let col_count = cells
                .as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.as_array())
                .map(|r| r.len() as i32)
                .unwrap_or(0);
            let title: String = row.get("title");
            TableSummary {
                table_id: row.get("table_id"),
                table_index: row.get("table_index"),
                title: if title.is_empty() { None } else { Some(title) },
                row_count,
                col_count,
                headers: metadata.get("headers").cloned().unwrap_or(json!([])),
                markdown: row.get("markdown"),
                quality: metadata.get("quality").cloned().unwrap_or(json!({})),
            }
        })
        .collect())
}

fn render_document_preview(
    document: &DocumentSummary,
    latest_job: Option<&ParseJobSummary>,
    blocks: &[BlockSummary],
) -> DocumentPreview {
    let char_count = latest_job
        .and_then(|job| job.char_count)
        .unwrap_or_else(|| blocks.iter().map(|b| b.text.chars().count() as i32).sum());

    if blocks.is_empty() {
        let mode = if document.parse_status == "parse_failed" {
            "failed"
        } else {
            "pending"
        };
        return DocumentPreview {
            mode: mode.to_string(),
            title: document.title.clone(),
            text: String::new(),
            truncated: false,
            source: "document_blocks".to_string(),
            char_count,
        };
    }

    let mut text = String::new();
    let mut written = 0usize;
    let mut truncated = false;

    for block in blocks {
        let rendered = render_preview_block(block);
        if rendered.trim().is_empty() {
            continue;
        }
        if !append_preview_text(&mut text, &rendered, &mut written) {
            truncated = true;
            break;
        }
        if !append_preview_text(&mut text, "\n\n", &mut written) {
            truncated = true;
            break;
        }
    }

    DocumentPreview {
        mode: "parsed_text".to_string(),
        title: document.title.clone(),
        text: text.trim_end().to_string(),
        truncated,
        source: "document_blocks".to_string(),
        char_count,
    }
}

fn render_preview_block(block: &BlockSummary) -> String {
    let text = block.text.trim();
    if text.is_empty() {
        return String::new();
    }

    if let Some(level) = block.heading_level {
        let level = level.clamp(1, 6) as usize;
        return format!("{} {}", "#".repeat(level), text);
    }

    if block.block_type == "table" {
        let heading = block
            .heading_path
            .last()
            .map(String::as_str)
            .unwrap_or("表格");
        return format!("[表格: {heading}]\n{text}");
    }

    text.to_string()
}

fn append_preview_text(target: &mut String, value: &str, written: &mut usize) -> bool {
    if *written >= PREVIEW_CHAR_LIMIT {
        return false;
    }

    let available = PREVIEW_CHAR_LIMIT - *written;
    let value_len = value.chars().count();
    if value_len <= available {
        target.push_str(value);
        *written += value_len;
        return true;
    }

    target.extend(value.chars().take(available));
    *written = PREVIEW_CHAR_LIMIT;
    false
}

fn sanitize_file_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0') && !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "document.bin".to_string()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// Parsing helpers (cloud base)
// ---------------------------------------------------------------------------

async fn read_multipart_file(multipart: &mut Multipart) -> Result<UploadedFile, AppError> {
    let mut file_name: Option<String> = None;
    let mut title: Option<String> = None;
    let mut bytes: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request("INVALID_MULTIPART", format!("上传表单无效: {e}")))?
    {
        let field_name = field.name().unwrap_or_default().to_string();
        match field_name.as_str() {
            "file" => {
                file_name = field.file_name().map(|s| s.to_string());
                let data = field.bytes().await.map_err(|e| {
                    AppError::bad_request("UPLOAD_READ_FAILED", format!("读取上传文件失败: {e}"))
                })?;
                bytes = Some(data.to_vec());
            }
            "title" => {
                let text = field.text().await.map_err(|e| {
                    AppError::bad_request("INVALID_MULTIPART", format!("读取标题失败: {e}"))
                })?;
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    title = Some(trimmed.to_string());
                }
            }
            _ => {}
        }
    }

    let bytes = bytes.ok_or_else(|| AppError::bad_request("FILE_REQUIRED", "缺少 file 字段"))?;
    if bytes.is_empty() {
        return Err(AppError::bad_request("FILE_EMPTY", "上传文件为空"));
    }
    let file_name = file_name.unwrap_or_else(|| "document".to_string());
    let title = title.unwrap_or_else(|| title_from_file_name(&file_name));

    Ok(UploadedFile {
        title,
        file_name,
        bytes,
    })
}

fn detect_file_type(file_name: &str, bytes: &[u8]) -> Result<String, AppError> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase();

    let file_type = match ext.as_str() {
        "pdf" if bytes.starts_with(b"%PDF") => "pdf",
        "docx" if bytes.starts_with(b"PK") => "docx",
        "pptx" if bytes.starts_with(b"PK") => "pptx",
        "txt" => "txt",
        "md" => "md",
        _ => {
            return Err(AppError::bad_request(
                "UNSUPPORTED_FILE_TYPE",
                "仅支持 pdf、docx、pptx、txt、md 文件",
            ));
        }
    };

    Ok(file_type.to_string())
}

fn parse_document(file_type: &str, bytes: &[u8]) -> Result<ParsedDocument> {
    match file_type {
        "pdf" => parse_pdf(bytes),
        "docx" => parse_docx(bytes),
        "pptx" => parse_pptx(bytes),
        "txt" | "md" => parse_plain_text(bytes),
        _ => Err(anyhow!("unsupported file type: {file_type}")),
    }
}

fn build_parse_artifacts(
    file_type: &str,
    file_sha256: &str,
    bytes: &[u8],
) -> Result<ParseArtifacts, AppError> {
    let parsed = parse_document(file_type, bytes)?;
    if parsed.blocks.is_empty() {
        return Err(AppError::bad_request(
            "DOCUMENT_EMPTY",
            "未能从文档中提取到可检索文本",
        ));
    }

    let parser_config = current_parser_config();
    let chunk_size = parser_config
        .get("chunk_size")
        .and_then(|value| value.as_u64())
        .unwrap_or(1500) as usize;
    let chunk_overlap = parser_config
        .get("chunk_overlap")
        .and_then(|value| value.as_u64())
        .unwrap_or(200) as usize;
    let chunks = build_chunks(&parsed.blocks, chunk_size, chunk_overlap);
    if chunks.is_empty() {
        return Err(AppError::bad_request(
            "DOCUMENT_EMPTY",
            "文档解析成功但没有生成有效切片",
        ));
    }

    let parse_identity = parse_identity_for(file_sha256, &parser_config);
    let quality_score = quality_score(&parsed.blocks);
    let parse_status = parse_status_for_quality(quality_score)?;
    let table_count = parsed
        .blocks
        .iter()
        .filter(|b| b.block_type == "table")
        .count();
    let mut parser_config = parser_config;
    if let Some(config) = parser_config.as_object_mut() {
        config.insert("warnings".to_string(), json!(parsed.warnings.clone()));
        config.insert("quality_score".to_string(), json!(quality_score));
        config.insert("parse_status".to_string(), json!(parse_status.clone()));
    }

    Ok(ParseArtifacts {
        parsed,
        chunks,
        parser_config,
        parse_identity,
        table_count,
        quality_score,
        parse_status,
    })
}

fn current_parser_config() -> serde_json::Value {
    json!({
        "chunk_size": env_usize("RAG_CHUNK_SIZE", 1500),
        "chunk_overlap": env_usize("RAG_CHUNK_OVERLAP", 200),
    })
}

fn parse_identity_for(file_sha256: &str, parser_config: &serde_json::Value) -> String {
    let chunk_size = parser_config
        .get("chunk_size")
        .and_then(|value| value.as_u64())
        .unwrap_or(1500);
    let chunk_overlap = parser_config
        .get("chunk_overlap")
        .and_then(|value| value.as_u64())
        .unwrap_or(200);
    sha256_hex(format!("{file_sha256}:{PARSER_VERSION}:{chunk_size}:{chunk_overlap}").as_bytes())
}

fn app_error_details(err: &AppError) -> (String, String) {
    match err {
        AppError::NotFound { code, message }
        | AppError::Forbidden { code, message }
        | AppError::Conflict { code, message }
        | AppError::InvalidState { code, message }
        | AppError::Timeout { code, message }
        | AppError::BadRequest { code, message }
        | AppError::Unauthorized { code, message } => (code.clone(), message.clone()),
        AppError::Internal(err) => ("PARSE_INTERNAL_ERROR".to_string(), err.to_string()),
    }
}

fn parse_plain_text(bytes: &[u8]) -> Result<ParsedDocument> {
    let text = String::from_utf8_lossy(bytes);
    Ok(ParsedDocument {
        blocks: text_blocks(
            &text,
            "paragraph",
            vec![],
            vec![],
            json!({ "format": "plain" }),
        ),
        warnings: vec![],
    })
}

fn parse_pdf(bytes: &[u8]) -> Result<ParsedDocument> {
    let text = pdf_extract::extract_text_from_mem(bytes).context("extract pdf text")?;
    let pages: Vec<&str> = text.split('\x0C').collect();
    let mut blocks = vec![];
    for (index, page_text) in pages.iter().enumerate() {
        let page = index as i32 + 1;
        blocks.extend(text_blocks(
            page_text,
            "paragraph",
            vec![],
            vec![page],
            json!({ "format": "pdf", "page": page }),
        ));
    }
    Ok(ParsedDocument {
        blocks,
        warnings: vec![],
    })
}

fn parse_docx(bytes: &[u8]) -> Result<ParsedDocument> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).context("open docx zip")?;
    let document_xml = read_zip_entry(&mut archive, "word/document.xml")?;
    let blocks = parse_docx_document_xml(&document_xml)?;
    Ok(ParsedDocument {
        blocks,
        warnings: vec![],
    })
}

fn parse_pptx(bytes: &[u8]) -> Result<ParsedDocument> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).context("open pptx zip")?;
    let mut names: Vec<String> = archive
        .file_names()
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .map(str::to_string)
        .collect();
    names.sort_by_key(|name| slide_number(name).unwrap_or(i32::MAX));

    let mut blocks = vec![];
    for name in names {
        let slide = slide_number(&name).unwrap_or(1);
        let xml = read_zip_entry(&mut archive, &name)?;
        blocks.extend(parse_pptx_slide_xml(&xml, slide)?);
    }
    Ok(ParsedDocument {
        blocks,
        warnings: vec![],
    })
}

fn parse_docx_document_xml(xml: &str) -> Result<Vec<ParsedBlock>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut blocks = vec![];
    let mut buf = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut in_paragraph = false;
    let mut table_depth = 0usize;
    let mut current_style: Option<String> = None;
    let mut heading_path: Vec<String> = vec![];
    let mut table_rows: Vec<String> = vec![];
    let mut table_cells: Vec<String> = vec![];

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                if name_ends_with(e.name().as_ref(), b"p") {
                    in_paragraph = true;
                    current.clear();
                    current_style = None;
                } else if name_ends_with(e.name().as_ref(), b"t") {
                    in_text = true;
                } else if name_ends_with(e.name().as_ref(), b"tbl") {
                    table_depth += 1;
                    table_rows.clear();
                } else if name_ends_with(e.name().as_ref(), b"tc") {
                    table_cells.clear();
                } else if name_ends_with(e.name().as_ref(), b"pStyle") {
                    current_style = attr_value(&e, b"val");
                }
            }
            Event::Empty(e) => {
                if name_ends_with(e.name().as_ref(), b"pStyle") {
                    current_style = attr_value(&e, b"val");
                }
            }
            Event::Text(e) => {
                if in_text {
                    let text = e.decode()?.into_owned();
                    current.push_str(&text);
                }
            }
            Event::End(e) => {
                if name_ends_with(e.name().as_ref(), b"t") {
                    in_text = false;
                } else if name_ends_with(e.name().as_ref(), b"p") && in_paragraph {
                    let text = normalize_text(&current);
                    if !text.is_empty() {
                        if table_depth > 0 {
                            table_cells.push(text);
                        } else {
                            let block_type = block_type_from_docx_style(current_style.as_deref());
                            if block_type == "heading" {
                                heading_path = vec![text.clone()];
                            }
                            blocks.push(ParsedBlock {
                                block_type: block_type.to_string(),
                                heading_path: heading_path.clone(),
                                page_range: vec![],
                                content: text,
                                metadata: json!({
                                    "format": "docx",
                                    "style": current_style,
                                }),
                            });
                        }
                    }
                    current.clear();
                    in_paragraph = false;
                } else if name_ends_with(e.name().as_ref(), b"tc") {
                    if !table_cells.is_empty() {
                        table_rows.push(format!("| {} |", table_cells.join(" | ")));
                    }
                    table_cells.clear();
                } else if name_ends_with(e.name().as_ref(), b"tbl") {
                    table_depth = table_depth.saturating_sub(1);
                    if table_depth == 0 && !table_rows.is_empty() {
                        blocks.push(ParsedBlock {
                            block_type: "table".to_string(),
                            heading_path: heading_path.clone(),
                            page_range: vec![],
                            content: table_rows.join("\n"),
                            metadata: json!({ "format": "docx", "source": "w:tbl" }),
                        });
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(blocks)
}

fn parse_pptx_slide_xml(xml: &str, slide: i32) -> Result<Vec<ParsedBlock>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut blocks = vec![];
    let mut buf = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut paragraph_index = 0usize;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                if name_ends_with(e.name().as_ref(), b"t") {
                    in_text = true;
                } else if name_ends_with(e.name().as_ref(), b"p") {
                    current.clear();
                }
            }
            Event::Text(e) => {
                if in_text {
                    current.push_str(&e.decode()?);
                }
            }
            Event::End(e) => {
                if name_ends_with(e.name().as_ref(), b"t") {
                    in_text = false;
                } else if name_ends_with(e.name().as_ref(), b"p") {
                    let text = normalize_text(&current);
                    if !text.is_empty() {
                        paragraph_index += 1;
                        blocks.push(ParsedBlock {
                            block_type: "slide_text".to_string(),
                            heading_path: vec![format!("Slide {slide}")],
                            page_range: vec![slide],
                            content: text,
                            metadata: json!({
                                "format": "pptx",
                                "slide": slide,
                                "paragraph_index": paragraph_index,
                            }),
                        });
                    }
                    current.clear();
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(blocks)
}

fn text_blocks(
    text: &str,
    block_type: &str,
    heading_path: Vec<String>,
    page_range: Vec<i32>,
    metadata: serde_json::Value,
) -> Vec<ParsedBlock> {
    text.split("\n\n")
        .flat_map(|part| part.split('\r'))
        .map(normalize_text)
        .filter(|part| !part.is_empty())
        .map(|content| ParsedBlock {
            block_type: block_type.to_string(),
            heading_path: heading_path.clone(),
            page_range: page_range.clone(),
            content,
            metadata: metadata.clone(),
        })
        .collect()
}

fn build_chunks(
    blocks: &[ParsedBlock],
    chunk_size: usize,
    chunk_overlap: usize,
) -> Vec<ChunkDraft> {
    let chunk_size = chunk_size.max(300);
    let chunk_overlap = chunk_overlap.min(chunk_size / 3);
    let mut chunks = vec![];
    let mut current = String::new();
    let mut heading_path: Vec<String> = vec![];
    let mut page_range: Vec<i32> = vec![];
    let mut block_count = 0usize;

    for block in blocks {
        for part in split_long_text(&block.content, chunk_size, chunk_overlap) {
            let addition = if block.heading_path.is_empty() {
                part
            } else {
                format!("{}\n{}", block.heading_path.join(" > "), part)
            };

            if !current.is_empty()
                && current.chars().count() + addition.chars().count() > chunk_size
            {
                chunks.push(chunk_from_parts(
                    &current,
                    &heading_path,
                    &page_range,
                    block_count,
                ));
                current.clear();
                heading_path.clear();
                page_range.clear();
                block_count = 0;
            }

            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(&addition);
            merge_strings(&mut heading_path, &block.heading_path);
            merge_i32(&mut page_range, &block.page_range);
            block_count += 1;
        }
    }

    if !current.is_empty() {
        chunks.push(chunk_from_parts(
            &current,
            &heading_path,
            &page_range,
            block_count,
        ));
    }

    chunks
}

fn split_long_text(text: &str, chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= chunk_size {
        return vec![text.to_string()];
    }

    let mut parts = vec![];
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + chunk_size).min(chars.len());
        parts.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(chunk_overlap);
    }
    parts
}

fn chunk_from_parts(
    content: &str,
    heading_path: &[String],
    page_range: &[i32],
    block_count: usize,
) -> ChunkDraft {
    ChunkDraft {
        content: content.to_string(),
        heading_path: heading_path.to_vec(),
        page_range: page_range.to_vec(),
        token_count: estimate_tokens(content),
        metadata: json!({ "block_count": block_count }),
    }
}

fn read_zip_entry(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String> {
    let mut file = archive
        .by_name(name)
        .with_context(|| format!("zip entry missing: {name}"))?;
    let mut xml = String::new();
    file.read_to_string(&mut xml)?;
    Ok(xml)
}

fn attr_value(e: &quick_xml::events::BytesStart<'_>, local_name: &[u8]) -> Option<String> {
    for attr in e.attributes().flatten() {
        if name_ends_with(attr.key.as_ref(), local_name) {
            return Some(String::from_utf8_lossy(attr.value.as_ref()).to_string());
        }
    }
    None
}

fn block_type_from_docx_style(style: Option<&str>) -> &'static str {
    let Some(style) = style else {
        return "paragraph";
    };
    let lower = style.to_lowercase();
    if lower.contains("heading") || lower.contains("title") || lower.starts_with('h') {
        "heading"
    } else {
        "paragraph"
    }
}

fn name_ends_with(name: &[u8], local_name: &[u8]) -> bool {
    name == local_name || name.ends_with(&[b":", local_name].concat())
}

fn slide_number(path: &str) -> Option<i32> {
    let file_name = Path::new(path).file_stem()?.to_str()?;
    file_name.strip_prefix("slide")?.parse().ok()
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn merge_strings(target: &mut Vec<String>, incoming: &[String]) {
    for value in incoming {
        if !target.contains(value) {
            target.push(value.clone());
        }
    }
}

fn merge_i32(target: &mut Vec<i32>, incoming: &[i32]) {
    for value in incoming {
        if !target.contains(value) {
            target.push(*value);
        }
    }
    target.sort_unstable();
}

fn estimate_tokens(text: &str) -> i32 {
    text.chars().count().div_ceil(2) as i32
}

fn quality_score(blocks: &[ParsedBlock]) -> f64 {
    let chars: usize = blocks.iter().map(|b| b.content.chars().count()).sum();
    if chars >= 1000 {
        0.95
    } else if chars >= 200 {
        0.85
    } else {
        0.65
    }
}

fn parse_status_for_quality(score: f64) -> Result<String, AppError> {
    if score >= 0.75 {
        Ok("indexed".to_string())
    } else if score >= 0.55 {
        Ok("parse_low_confidence".to_string())
    } else {
        Err(AppError::bad_request(
            "PARSE_QUALITY_TOO_LOW",
            "文档解析质量过低，未进入索引",
        ))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn title_from_file_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("未命名文档")
        .trim()
        .to_string()
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[allow(dead_code)]
fn _debug_block_counts(blocks: &[ParsedBlock]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for block in blocks {
        *counts.entry(block.block_type.clone()).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    use super::*;

    #[test]
    fn parses_docx_paragraphs_and_tables() {
        let xml = r#"
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body>
                <w:p>
                  <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
                  <w:r><w:t>付款条款</w:t></w:r>
                </w:p>
                <w:p><w:r><w:t>合同签署后支付首付款30%。</w:t></w:r></w:p>
                <w:tbl>
                  <w:tr>
                    <w:tc><w:p><w:r><w:t>阶段</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>比例</w:t></w:r></w:p></w:tc>
                  </w:tr>
                </w:tbl>
              </w:body>
            </w:document>
        "#;
        let bytes = zip_with_entries(&[("word/document.xml", xml)]);

        let parsed = parse_docx(&bytes).unwrap();

        assert!(parsed
            .blocks
            .iter()
            .any(|b| b.block_type == "heading" && b.content == "付款条款"));
        assert!(parsed
            .blocks
            .iter()
            .any(|b| b.content.contains("首付款30%")));
        assert!(parsed.blocks.iter().any(|b| b.block_type == "table"));
    }

    #[test]
    fn parses_pptx_slides_with_page_range() {
        let xml = r#"
            <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                   xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <p:cSld><p:spTree><p:sp><p:txBody>
                <a:p><a:r><a:t>Q3华东区域销售目标为1200万元</a:t></a:r></a:p>
              </p:txBody></p:sp></p:spTree></p:cSld>
            </p:sld>
        "#;
        let bytes = zip_with_entries(&[("ppt/slides/slide3.xml", xml)]);

        let parsed = parse_pptx(&bytes).unwrap();

        assert_eq!(parsed.blocks.len(), 1);
        assert_eq!(parsed.blocks[0].page_range, vec![3]);
        assert!(parsed.blocks[0].content.contains("1200万元"));
    }

    #[test]
    fn builds_chunks_from_blocks() {
        let blocks = vec![
            ParsedBlock {
                block_type: "paragraph".to_string(),
                heading_path: vec!["付款条款".to_string()],
                page_range: vec![5],
                content: "合同签署后支付首付款30%。".to_string(),
                metadata: json!({}),
            },
            ParsedBlock {
                block_type: "paragraph".to_string(),
                heading_path: vec!["付款条款".to_string()],
                page_range: vec![6],
                content: "验收通过后支付60%。".to_string(),
                metadata: json!({}),
            },
        ];

        let chunks = build_chunks(&blocks, 300, 50);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].page_range, vec![5, 6]);
        assert!(chunks[0].content.contains("付款条款"));
    }

    #[test]
    fn short_parse_is_low_confidence_and_not_indexed() {
        let artifacts = build_parse_artifacts("txt", "sha-short", "短文本".as_bytes()).unwrap();

        assert_eq!(artifacts.parse_status, "parse_low_confidence");
        assert!(artifacts.quality_score >= 0.55);
        assert_eq!(artifacts.chunks.len(), 1);
    }

    #[test]
    fn long_parse_is_indexed() {
        let text = "付款节点包括首付款、验收款和质保金。".repeat(80);
        let artifacts = build_parse_artifacts("txt", "sha-long", text.as_bytes()).unwrap();

        assert_eq!(artifacts.parse_status, "indexed");
        assert!(artifacts.quality_score >= 0.75);
    }

    #[test]
    fn pending_identity_matches_completed_artifacts() {
        let text = "付款节点包括首付款、验收款和质保金。".repeat(80);
        let file_sha256 = sha256_hex(text.as_bytes());
        let pending_identity = parse_identity_for(&file_sha256, &current_parser_config());

        let artifacts = build_parse_artifacts("txt", &file_sha256, text.as_bytes()).unwrap();

        assert_eq!(pending_identity, artifacts.parse_identity);
        assert_eq!(artifacts.parse_status, "indexed");
    }

    fn zip_with_entries(entries: &[(&str, &str)]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        for (name, content) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
}
