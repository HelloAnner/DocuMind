use std::path::Path;

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::auth::{require_kb_permission, require_permission, ActorExtractor};
use crate::config::EmbeddingConfig;
use crate::document::{self as ingest, cleaning::cleaned_block_metadata};
use crate::error::AppError;
use crate::rag::embedding::{EmbeddingClient, EmbeddingClientConfig};
use crate::rag::vector_index::{
    ElasticsearchChunkIndexer, ElasticsearchConfig, EsRange, IndexedChunk,
};
use crate::state::AppState;

const PARSER_VERSION: &str = ingest::PARSER_VERSION;
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
            get(get_document)
                .delete(delete_document)
                .post(reprocess_document),
        )
        .route(
            "/api/admin/documents/:doc_id/original",
            get(download_original),
        )
        .route(
            "/api/admin/documents/:doc_id/pages/:page/pdf",
            get(download_page_pdf),
        )
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
    cleaned_blocks: Vec<CleanedBlockSummary>,
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
struct CleanedBlockSummary {
    block_id: Uuid,
    block_index: i32,
    block_type: String,
    cleaned_text: String,
    is_removed: bool,
    remove_reason: Option<String>,
    cleaning_ops: Vec<String>,
    heading_path: Vec<String>,
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

struct UploadedFile {
    title: String,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
}

struct ParseArtifacts {
    bundle: ingest::ParsedBundle,
    parser_config: serde_json::Value,
    parse_identity: String,
    quality_score: f64,
    parse_status: String,
}

#[derive(Debug)]
struct DocumentRecord {
    id: Uuid,
    tenant_id: Uuid,
    kb_id: Uuid,
    title: String,
    file_type: String,
    file_name: String,
    mime_type: String,
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
    title: String,
    file_name: String,
    mime_type: String,
    file_type: String,
    file_sha256: String,
    bytes: Vec<u8>,
    embedding_config: EmbeddingConfig,
    elasticsearch_url: Option<String>,
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
    let file_format =
        ingest::detect_file_type(&uploaded.file_name, &uploaded.mime_type, &uploaded.bytes)
            .map_err(|err| AppError::bad_request("UNSUPPORTED_FILE_TYPE", err.to_string()))?;
    let file_type = file_format.as_str().to_string();
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
        "mime_type": uploaded.mime_type,
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
            title: uploaded.title.clone(),
            file_name: uploaded.file_name.clone(),
            mime_type: uploaded.mime_type.clone(),
            file_type: file_type.clone(),
            file_sha256,
            bytes: uploaded.bytes,
            embedding_config: state.config.rag.embedding.clone(),
            elasticsearch_url: state.config.elasticsearch_url.clone(),
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
        return Err(AppError::bad_request("DOC_IDS_EMPTY", "请选择要重试的文档"));
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
               COALESCE((j.parser_config->>'table_count')::int, 0) AS table_count,
               COALESCE((j.parser_config->>'page_count')::int, NULL)::int AS page_count,
               d.created_at AS uploaded_at, d.updated_at
        FROM documents d
        JOIN knowledge_base kb ON kb.id = d.kb_id
        LEFT JOIN document_parse_jobs j ON j.parse_job_id = d.latest_parse_job_id
        WHERE d.tenant_id = $1
          AND ($2::uuid IS NULL OR d.kb_id = $2)
          AND (
            $3::text IS NULL OR $3 = 'all' OR d.parse_status = $3
            OR ($3 = 'done' AND d.parse_status IN ('parsed', 'cleaned', 'chunked', 'indexed'))
          )
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
    let cleaned_blocks = fetch_cleaned_blocks(pool, doc_id, document.latest_parse_job_id).await?;
    let chunks = fetch_chunks(pool, doc_id, document.latest_parse_job_id).await?;
    let tables = fetch_tables(pool, doc_id, document.latest_parse_job_id).await?;
    let preview = render_document_preview(&document, latest_job.as_ref(), &blocks);
    Ok(Json(DocumentDetail {
        document,
        latest_job,
        preview,
        blocks,
        cleaned_blocks,
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

    Ok(Json(
        fetch_document_summary(pool, actor.tenant_id, doc_id).await?,
    ))
}

async fn download_original(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
    req_headers: HeaderMap,
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
    let total_size = state.storage.size(&storage_key).await?;

    if let Some(range) = req_headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        if let Some((start, end)) = parse_byte_range(range, total_size) {
            let bytes = state.storage.get_range(&storage_key, start, end).await?;
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!(
                    "bytes {}-{}/{}",
                    start,
                    end.saturating_sub(1),
                    total_size
                ))
                .unwrap_or_else(|_| HeaderValue::from_static("bytes */*")),
            );
            return Ok((StatusCode::PARTIAL_CONTENT, headers, bytes).into_response());
        }
    }

    let bytes = state.storage.get(&storage_key).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
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

fn parse_byte_range(range: &str, total_size: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let (start_str, end_str) = range.split_once('-')?;

    if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        let start = total_size.saturating_sub(suffix);
        return Some((start, total_size));
    }

    let start: u64 = start_str.parse().ok()?;
    let end = if end_str.is_empty() {
        total_size
    } else {
        end_str.parse::<u64>().ok()?.min(total_size)
    };

    if start >= end || start >= total_size {
        return None;
    }
    Some((start, end))
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
            title: doc.title,
            file_name: doc.file_name,
            mime_type: doc.mime_type,
            file_type: doc.file_type.clone(),
            file_sha256: doc.file_sha256,
            bytes,
            embedding_config: state.config.rag.embedding.clone(),
            elasticsearch_url: state.config.elasticsearch_url.clone(),
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
        "SELECT id, tenant_id, kb_id, title, file_type,
                COALESCE(metadata->>'original_filename', storage_key) AS file_name,
                COALESCE(metadata->>'mime_type', 'application/octet-stream') AS mime_type,
                storage_key, file_sha256, parse_version
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
        title: row.get("title"),
        file_type: row.get("file_type"),
        file_name: row.get("file_name"),
        mime_type: row.get("mime_type"),
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

    match build_parse_artifacts(&task) {
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
            if artifacts.parse_status == "chunked" {
                if let Err(err) = run_embedding_job(&pool, &task, &artifacts).await {
                    mark_embedding_failed(&pool, &task, &err.to_string()).await?;
                }
            }
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
        "INSERT INTO document_parse_results (parse_job_id, doc_id, parsed_json, schema_version)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(scope.parse_job_id)
    .bind(scope.doc_id)
    .bind(serde_json::to_value(&artifacts.bundle.parsed).unwrap_or_else(|_| json!({})))
    .bind(ingest::SCHEMA_VERSION)
    .execute(&mut **tx)
    .await?;

    for anchor in &artifacts.bundle.parsed.anchors {
        sqlx::query(
            "INSERT INTO document_source_anchors (
                id, doc_id, parse_job_id, tenant_id, format, kind,
                page, slide, block_id, table_id, cell_range, char_range,
                bbox, source_ref, text, text_hash, anchor_quality
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (id) DO UPDATE
             SET doc_id = EXCLUDED.doc_id,
                 parse_job_id = EXCLUDED.parse_job_id,
                 tenant_id = EXCLUDED.tenant_id,
                 format = EXCLUDED.format,
                 kind = EXCLUDED.kind,
                 page = EXCLUDED.page,
                 slide = EXCLUDED.slide,
                 block_id = EXCLUDED.block_id,
                 table_id = EXCLUDED.table_id,
                 cell_range = EXCLUDED.cell_range,
                 char_range = EXCLUDED.char_range,
                 bbox = EXCLUDED.bbox,
                 source_ref = EXCLUDED.source_ref,
                 text = EXCLUDED.text,
                 text_hash = EXCLUDED.text_hash,
                 anchor_quality = EXCLUDED.anchor_quality",
        )
        .bind(anchor.anchor_id)
        .bind(scope.doc_id)
        .bind(scope.parse_job_id)
        .bind(scope.tenant_id)
        .bind(&anchor.format)
        .bind(&anchor.kind)
        .bind(anchor.page)
        .bind(anchor.slide)
        .bind(anchor.block_id)
        .bind(anchor.table_id)
        .bind(sqlx::types::Json(anchor.cell_range.as_ref()))
        .bind(sqlx::types::Json(anchor.char_range.as_ref()))
        .bind(sqlx::types::Json(anchor.bbox.as_ref()))
        .bind(&anchor.source_ref)
        .bind(&anchor.text)
        .bind(&anchor.text_hash)
        .bind(&anchor.anchor_quality)
        .execute(&mut **tx)
        .await?;
    }

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
    .bind(artifacts.bundle.chunks.len() as i32)
    .bind(json!({
        "quality_score": artifacts.quality_score,
        "warnings": artifacts.bundle.parsed.warnings.clone(),
        "clean_stats": artifacts.bundle.clean_stats,
        "file_type": file_type,
    }))
    .bind(scope.doc_id)
    .execute(&mut **tx)
    .await?;

    for block in &artifacts.bundle.parsed.blocks {
        sqlx::query(
            "INSERT INTO document_blocks (
                id, tenant_id, kb_id, doc_id, parse_job_id, block_index, block_type,
                heading_path, page_range, content, anchor_ids, metadata
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        )
        .bind(block.block_id)
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(scope.parse_job_id)
        .bind(block.block_index + 1)
        .bind(&block.block_type)
        .bind(&block.heading_path)
        .bind(page_range(block.page_start, block.page_end))
        .bind(&block.text)
        .bind(&block.anchor_ids)
        .bind(json!({
            "heading_level": block.heading_level,
            "slide": block.slide_index,
            "table_id": block.table_id,
            "bbox": block.bbox,
            "source_ref": block.source_ref,
            "metadata": block.metadata,
        }))
        .execute(&mut **tx)
        .await?;
    }

    for block in &artifacts.bundle.cleaned_blocks {
        sqlx::query(
            "INSERT INTO cleaned_blocks (
                tenant_id, kb_id, doc_id, parse_job_id, block_id, block_index, block_type,
                cleaned_text, is_removed, remove_reason, cleaning_ops,
                heading_path, page_range, metadata
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (parse_job_id, block_id) DO UPDATE
             SET cleaned_text = EXCLUDED.cleaned_text,
                 is_removed = EXCLUDED.is_removed,
                 remove_reason = EXCLUDED.remove_reason,
                 cleaning_ops = EXCLUDED.cleaning_ops,
                 metadata = EXCLUDED.metadata",
        )
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(scope.parse_job_id)
        .bind(block.block.block_id)
        .bind(block.block.block_index + 1)
        .bind(&block.block.block_type)
        .bind(&block.cleaned_text)
        .bind(block.is_removed)
        .bind(&block.remove_reason)
        .bind(&block.cleaning_ops)
        .bind(&block.block.heading_path)
        .bind(page_range(block.block.page_start, block.block.page_end))
        .bind(cleaned_block_metadata(block))
        .execute(&mut **tx)
        .await?;
    }

    for table in &artifacts.bundle.parsed.tables {
        sqlx::query(
            "INSERT INTO document_tables (
                id, tenant_id, kb_id, doc_id, parse_job_id, table_index,
                heading_path, page_range, markdown, cells, metadata
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(table.table_id)
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(scope.parse_job_id)
        .bind(table.table_index + 1)
        .bind(&table.heading_path)
        .bind(page_range(table.page_start, table.page_end))
        .bind(&table.markdown)
        .bind(json!(table.rows))
        .bind(json!({
            "block_id": table.block_id,
            "title": table.title,
            "headers": table.headers,
            "row_count": table.rows.len(),
            "col_count": table.headers.len(),
            "quality": table.quality,
            "source_ref": table.source_ref,
            "slide": table.slide_index,
        }))
        .execute(&mut **tx)
        .await?;

        for cell in &table.cells {
            sqlx::query(
                "INSERT INTO document_table_cells (
                    id, tenant_id, kb_id, doc_id, parse_job_id, table_id,
                    row_index, col_index, row_span, col_span, text, metadata
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (table_id, row_index, col_index) DO UPDATE
                 SET text = EXCLUDED.text, metadata = EXCLUDED.metadata",
            )
            .bind(cell.cell_id)
            .bind(scope.tenant_id)
            .bind(scope.kb_id)
            .bind(scope.doc_id)
            .bind(scope.parse_job_id)
            .bind(table.table_id)
            .bind(cell.row_index)
            .bind(cell.col_index)
            .bind(cell.rowspan)
            .bind(cell.colspan)
            .bind(&cell.text)
            .bind(json!({
                "normalized_text": cell.normalized_text,
                "is_header": cell.is_header,
                "data_type": cell.data_type,
                "bbox": cell.bbox,
                "style": cell.style,
                "source_ref": cell.source_ref,
            }))
            .execute(&mut **tx)
            .await?;
        }
    }

    for chunk in &artifacts.bundle.chunks {
        sqlx::query(
            "INSERT INTO chunks (
                id, tenant_id, kb_id, doc_id, parse_job_id, chunk_index,
                source_type, content, heading_path, page_range, token_count,
                block_ids, table_ids, anchor_ids, primary_anchor_id, anchor_quality,
                overlap_prev_block_ids, overlap_next_block_ids, metadata
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)",
        )
        .bind(chunk.chunk_id)
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(scope.parse_job_id)
        .bind(chunk.chunk_index + 1)
        .bind(&chunk.source_type)
        .bind(&chunk.content)
        .bind(&chunk.heading_path)
        .bind(page_range(chunk.page_start, chunk.page_end))
        .bind(chunk.token_count)
        .bind(&chunk.block_ids)
        .bind(&chunk.table_ids)
        .bind(&chunk.anchor_ids)
        .bind(chunk.primary_anchor_id)
        .bind(&chunk.anchor_quality)
        .bind(uuid_list_from_metadata(
            &chunk.metadata,
            "overlap_prev_block_ids",
        ))
        .bind(uuid_list_from_metadata(
            &chunk.metadata,
            "overlap_next_block_ids",
        ))
        .bind(json!({
            "slide_start": chunk.slide_start,
            "slide_end": chunk.slide_end,
            "block_ids": chunk.block_ids,
            "table_ids": chunk.table_ids,
            "anchor_ids": chunk.anchor_ids,
            "primary_anchor_id": chunk.primary_anchor_id,
            "anchor_quality": chunk.anchor_quality,
            "source_type": chunk.source_type,
            "chunk_metadata": chunk.metadata,
        }))
        .execute(&mut **tx)
        .await?;

        for table_id in &chunk.table_ids {
            sqlx::query(
                "INSERT INTO chunk_tables (chunk_id, table_id)
                 VALUES ($1, $2)
                 ON CONFLICT (chunk_id, table_id) DO NOTHING",
            )
            .bind(chunk.chunk_id)
            .bind(table_id)
            .execute(&mut **tx)
            .await?;
        }

        for anchor_id in &chunk.anchor_ids {
            sqlx::query(
                "INSERT INTO chunk_anchor_map (chunk_id, anchor_id, relation)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (chunk_id, anchor_id) DO NOTHING",
            )
            .bind(chunk.chunk_id)
            .bind(anchor_id)
            .bind(if Some(*anchor_id) == chunk.primary_anchor_id {
                "primary"
            } else {
                "covered"
            })
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(())
}

async fn run_embedding_job(
    pool: &sqlx::PgPool,
    task: &ParseJobTask,
    artifacts: &ParseArtifacts,
) -> Result<(), anyhow::Error> {
    if !task.embedding_config.enabled {
        return Ok(());
    }
    let elasticsearch_url = task
        .elasticsearch_url
        .clone()
        .ok_or_else(|| anyhow::anyhow!("ELASTICSEARCH_URL is required for chunk indexing"))?;
    let client_config = EmbeddingClientConfig::try_from(&task.embedding_config)?;
    let embedding_client = EmbeddingClient::new(client_config)?;
    let indexer = ElasticsearchChunkIndexer::new(ElasticsearchConfig {
        base_url: elasticsearch_url,
        index_name: task.embedding_config.index_name.clone(),
        alias_name: task.embedding_config.index_alias.clone(),
        timeout_seconds: 120,
    })?;

    mark_embedding_running(pool, task, embedding_client.model()).await?;

    let now = Utc::now();
    let mut indexed_chunks = Vec::new();
    for batch in artifacts
        .bundle
        .chunks
        .chunks(embedding_client.batch_size())
    {
        let inputs = batch
            .iter()
            .map(|chunk| chunk.content.clone())
            .collect::<Vec<_>>();
        let vectors = embedding_client.embed_batch(&inputs).await?;
        let dims = vectors
            .first()
            .map(Vec::len)
            .ok_or_else(|| anyhow::anyhow!("embedding provider returned no vectors"))?;
        if vectors.iter().any(|vector| vector.len() != dims) {
            anyhow::bail!("embedding provider returned vectors with inconsistent dimensions");
        }

        let mut tx = pool.begin().await?;
        for (chunk, vector) in batch.iter().zip(vectors.into_iter()) {
            let vector_dim = vector.len() as i32;
            let vector_json = json!(vector.clone());
            sqlx::query(
                "INSERT INTO chunk_embeddings (
                    tenant_id, kb_id, doc_id, chunk_id, embedding_model, embedding_dim,
                    embedding_vector, content_hash, status, error_message, embedded_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', NULL, NOW())
                 ON CONFLICT (chunk_id, embedding_model) DO UPDATE
                 SET embedding_dim = EXCLUDED.embedding_dim,
                     embedding_vector = EXCLUDED.embedding_vector,
                     content_hash = EXCLUDED.content_hash,
                     status = 'completed',
                     error_message = NULL,
                     embedded_at = NOW()",
            )
            .bind(task.tenant_id)
            .bind(task.kb_id)
            .bind(task.doc_id)
            .bind(chunk.chunk_id)
            .bind(embedding_client.model())
            .bind(vector_dim)
            .bind(vector_json)
            .bind(sha256_hex(chunk.content.as_bytes()))
            .execute(&mut *tx)
            .await?;

            indexed_chunks.push(IndexedChunk {
                chunk_id: chunk.chunk_id,
                doc_id: task.doc_id,
                kb_id: task.kb_id,
                tenant_id: task.tenant_id,
                parse_job_id: task.parse_job_id,
                chunk_index: chunk.chunk_index + 1,
                source_type: chunk.source_type.clone(),
                content: chunk.content.clone(),
                heading_path: chunk.heading_path.clone(),
                page_range: es_range(chunk.page_start, chunk.page_end),
                slide_start: chunk.slide_start,
                slide_end: chunk.slide_end,
                token_count: chunk.token_count,
                block_ids: chunk.block_ids.clone(),
                table_ids: chunk.table_ids.clone(),
                anchor_ids: chunk.anchor_ids.clone(),
                primary_anchor_id: chunk.primary_anchor_id,
                anchor_quality: chunk.anchor_quality.clone(),
                anchor_page: chunk
                    .primary_anchor_id
                    .and_then(|id| artifacts.bundle.parsed.anchors.iter().find(|a| a.anchor_id == id))
                    .and_then(|a| a.page),
                anchor_slide: chunk
                    .primary_anchor_id
                    .and_then(|id| artifacts.bundle.parsed.anchors.iter().find(|a| a.anchor_id == id))
                    .and_then(|a| a.slide),
                anchor_bbox: chunk
                    .primary_anchor_id
                    .and_then(|id| artifacts.bundle.parsed.anchors.iter().find(|a| a.anchor_id == id))
                    .and_then(|a| a.bbox.clone()),
                anchor_text: chunk
                    .primary_anchor_id
                    .and_then(|id| artifacts.bundle.parsed.anchors.iter().find(|a| a.anchor_id == id))
                    .map(|a| a.text.clone())
                    .unwrap_or_default(),
                embedding_model: embedding_client.model().to_string(),
                embedding: vector,
                metadata: chunk.metadata.clone(),
                created_at: now,
                embedded_at: now,
            });
        }
        tx.commit().await?;
    }

    for batch in indexed_chunks.chunks(500) {
        indexer.bulk_index(batch).await?;
    }
    mark_embedding_completed(
        pool,
        task,
        embedding_client.model(),
        indexed_chunks.len() as i32,
    )
    .await?;
    Ok(())
}

async fn mark_embedding_running(
    pool: &sqlx::PgPool,
    task: &ParseJobTask,
    model: &str,
) -> Result<(), anyhow::Error> {
    sqlx::query(
        "UPDATE documents
         SET parse_status = 'embedding',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(json!({
        "active_parse_job_id": task.parse_job_id,
        "parse_progress": 85,
        "embedding_model": model,
    }))
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_embedding_completed(
    pool: &sqlx::PgPool,
    task: &ParseJobTask,
    model: &str,
    indexed_chunks: i32,
) -> Result<(), anyhow::Error> {
    sqlx::query(
        "UPDATE documents
         SET parse_status = 'indexed',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(json!({
        "active_parse_job_id": task.parse_job_id,
        "parse_progress": 100,
        "embedding_model": model,
        "indexed_chunks": indexed_chunks,
    }))
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_embedding_failed(
    pool: &sqlx::PgPool,
    task: &ParseJobTask,
    error_message: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE documents
         SET parse_status = 'embedding_failed',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(json!({
        "active_parse_job_id": task.parse_job_id,
        "parse_progress": 100,
        "error_code": "EMBEDDING_FAILED",
        "error_message": error_message,
    }))
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .execute(pool)
    .await?;

    sqlx::query(
        "UPDATE chunk_embeddings
         SET status = 'failed',
             error_message = $1
         WHERE tenant_id = $2
           AND doc_id = $3
           AND status <> 'completed'",
    )
    .bind(error_message)
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn es_range(start: Option<i32>, end: Option<i32>) -> Option<EsRange> {
    match (start, end) {
        (Some(start), Some(end)) => Some(EsRange {
            gte: start,
            lte: end,
        }),
        (Some(value), None) | (None, Some(value)) => Some(EsRange {
            gte: value,
            lte: value,
        }),
        (None, None) => None,
    }
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
               COALESCE((j.parser_config->>'table_count')::int, 0) AS table_count,
               COALESCE((j.parser_config->>'page_count')::int, NULL)::int AS page_count,
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
               (parser_config->>'page_count')::int AS page_count,
               (parser_config->>'block_count')::int AS block_count,
               (parser_config->>'table_count')::int AS table_count,
               (parser_config->>'char_count')::int AS char_count,
               COALESCE(parser_config->'warnings', '[]'::jsonb) AS warnings,
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
        SELECT id AS chunk_id, chunk_index,
               COALESCE(source_type, metadata->>'source_type', 'paragraph') AS source_type,
               content, heading_path, page_range, token_count, metadata
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
                source_type: row.get("source_type"),
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

async fn fetch_cleaned_blocks(
    pool: &sqlx::PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
) -> Result<Vec<CleanedBlockSummary>, AppError> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(vec![]);
    };
    let rows = sqlx::query(
        r#"
        SELECT block_id, block_index, block_type, cleaned_text, is_removed,
               remove_reason, cleaning_ops, heading_path
        FROM cleaned_blocks
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
        .map(|row| CleanedBlockSummary {
            block_id: row.get("block_id"),
            block_index: row.get("block_index"),
            block_type: row.get("block_type"),
            cleaned_text: row.get("cleaned_text"),
            is_removed: row.get("is_removed"),
            remove_reason: row.get("remove_reason"),
            cleaning_ops: row.get("cleaning_ops"),
            heading_path: row.get("heading_path"),
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
            let row_count = metadata
                .get("row_count")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32)
                .unwrap_or_else(|| cells.as_array().map(|a| a.len() as i32).unwrap_or(0));
            let col_count = metadata
                .get("col_count")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32)
                .unwrap_or_else(|| {
                    cells
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|r| r.as_array())
                        .map(|r| r.len() as i32)
                        .unwrap_or(0)
                });
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

fn page_range(start: Option<i32>, end: Option<i32>) -> Vec<i32> {
    match (start, end) {
        (Some(start), Some(end)) if end >= start => (start..=end).collect(),
        (Some(start), _) => vec![start],
        (_, Some(end)) => vec![end],
        _ => vec![],
    }
}

fn uuid_list_from_metadata(metadata: &Value, key: &str) -> Vec<Uuid> {
    metadata
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str())
                .filter_map(|value| Uuid::parse_str(value).ok())
                .collect()
        })
        .unwrap_or_default()
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
    let mut mime_type: Option<String> = None;
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
                mime_type = Some(
                    field
                        .content_type()
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| "application/octet-stream".to_string()),
                );
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
    let mime_type = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());

    Ok(UploadedFile {
        title,
        file_name,
        mime_type,
        bytes,
    })
}

fn build_parse_artifacts(task: &ParseJobTask) -> Result<ParseArtifacts, AppError> {
    let mut bundle = ingest::parse_document(
        task.doc_id,
        task.parse_job_id,
        &task.file_name,
        &task.mime_type,
        &task.bytes,
    )
    .map_err(|err| AppError::bad_request("DOCUMENT_PARSE_FAILED", err.to_string()))?;
    bundle.parsed.title = task.title.clone();

    if bundle.parsed.blocks.is_empty() {
        return Err(AppError::bad_request(
            "DOCUMENT_EMPTY",
            "未能从文档中提取到可检索文本",
        ));
    }

    if bundle.chunks.is_empty() {
        return Err(AppError::bad_request(
            "DOCUMENT_EMPTY",
            "文档解析成功但没有生成有效切片",
        ));
    }

    let parser_config = current_parser_config();
    let parse_identity = parse_identity_for(&task.file_sha256, &parser_config);
    let quality_score = bundle.parsed.quality_score;
    let parse_status = parse_status_for_quality(quality_score)?;
    let mut parser_config = parser_config;
    if let Some(config) = parser_config.as_object_mut() {
        config.insert(
            "warnings".to_string(),
            json!(bundle.parsed.warnings.clone()),
        );
        config.insert("quality_score".to_string(), json!(quality_score));
        config.insert("parse_status".to_string(), json!(parse_status.clone()));
        config.insert("block_count".to_string(), json!(bundle.parsed.blocks.len()));
        config.insert(
            "cleaned_block_count".to_string(),
            json!(bundle.clean_stats.output_blocks),
        );
        config.insert(
            "removed_block_count".to_string(),
            json!(bundle.clean_stats.removed_blocks),
        );
        config.insert("table_count".to_string(), json!(bundle.parsed.tables.len()));
        config.insert("chunk_count".to_string(), json!(bundle.chunks.len()));
        config.insert(
            "char_count".to_string(),
            json!(bundle
                .cleaned_blocks
                .iter()
                .filter(|b| !b.is_removed)
                .map(|b| b.cleaned_text.chars().count())
                .sum::<usize>()),
        );
        config.insert("clean_stats".to_string(), json!(bundle.clean_stats));
    }

    Ok(ParseArtifacts {
        bundle,
        parser_config,
        parse_identity,
        quality_score,
        parse_status,
    })
}

fn current_parser_config() -> serde_json::Value {
    json!({
        "parser_version": PARSER_VERSION,
        "cleaner_version": ingest::CLEANER_VERSION,
        "chunker_version": ingest::CHUNKER_VERSION,
        "target_chunk_tokens": env_usize("RAG_TARGET_CHUNK_TOKENS", 800),
        "max_chunk_tokens": env_usize("RAG_MAX_CHUNK_TOKENS", 1500),
        "chunk_overlap_tokens": env_usize("RAG_CHUNK_OVERLAP_TOKENS", 200),
    })
}

fn parse_identity_for(file_sha256: &str, parser_config: &serde_json::Value) -> String {
    sha256_hex(format!("{file_sha256}:{PARSER_VERSION}:{parser_config}").as_bytes())
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

fn parse_status_for_quality(score: f64) -> Result<String, AppError> {
    if score >= 0.75 {
        Ok("chunked".to_string())
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

        let bundle = ingest::parse_document(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "contract.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            &bytes,
        )
        .unwrap();

        assert!(bundle
            .parsed
            .blocks
            .iter()
            .any(|b| b.block_type == "heading" && b.text == "付款条款"));
        assert!(bundle
            .parsed
            .blocks
            .iter()
            .any(|b| b.text.contains("首付款30%")));
        assert!(bundle.parsed.blocks.iter().any(|b| b.block_type == "table"));
        assert!(bundle.cleaned_blocks.iter().any(|b| !b.is_removed));
        assert!(bundle.chunks.iter().any(|c| c.source_type == "table"));
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
        let bytes = zip_with_entries(&[
            ("ppt/presentation.xml", "<p:presentation/>"),
            ("ppt/slides/slide3.xml", xml),
        ]);

        let bundle = ingest::parse_document(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "slides.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            &bytes,
        )
        .unwrap();

        assert_eq!(bundle.parsed.blocks.len(), 1);
        assert_eq!(bundle.parsed.blocks[0].slide_index, Some(1));
        assert!(bundle.parsed.blocks[0].text.contains("1200万元"));
    }

    #[test]
    fn builds_chunks_from_blocks() {
        let text = "# 付款条款\n\n合同签署后支付首付款30%。\n\n验收通过后支付60%。";
        let bundle = ingest::parse_document(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "terms.md",
            "text/markdown",
            text.as_bytes(),
        )
        .unwrap();

        assert_eq!(bundle.chunks.len(), 1);
        assert!(bundle.chunks[0].content.contains("付款条款"));
        assert_eq!(bundle.chunks[0].block_ids.len(), 3);
    }

    #[test]
    fn short_parse_is_low_confidence_and_not_indexed() {
        let artifacts = build_parse_artifacts(&test_task("short.txt", "短文本")).unwrap();

        assert_eq!(artifacts.parse_status, "parse_low_confidence");
        assert!(artifacts.quality_score >= 0.55);
        assert_eq!(artifacts.bundle.chunks.len(), 1);
    }

    #[test]
    fn long_parse_is_chunked() {
        let text = "付款节点包括首付款、验收款和质保金。".repeat(80);
        let artifacts = build_parse_artifacts(&test_task("long.txt", &text)).unwrap();

        assert_eq!(artifacts.parse_status, "chunked");
        assert!(artifacts.quality_score >= 0.75);
        assert!(artifacts.bundle.clean_stats.output_blocks > 0);
    }

    #[test]
    fn pending_identity_matches_completed_artifacts() {
        let text = "付款节点包括首付款、验收款和质保金。".repeat(80);
        let file_sha256 = sha256_hex(text.as_bytes());
        let pending_identity = parse_identity_for(&file_sha256, &current_parser_config());

        let artifacts = build_parse_artifacts(&test_task("identity.txt", &text)).unwrap();

        assert_eq!(pending_identity, artifacts.parse_identity);
        assert_eq!(artifacts.parse_status, "chunked");
    }

    fn test_task(file_name: &str, text: &str) -> ParseJobTask {
        ParseJobTask {
            tenant_id: Uuid::new_v4(),
            kb_id: Uuid::new_v4(),
            doc_id: Uuid::new_v4(),
            parse_job_id: Uuid::new_v4(),
            parse_version: 1,
            title: title_from_file_name(file_name),
            file_name: file_name.to_string(),
            mime_type: "text/plain".to_string(),
            file_type: "txt".to_string(),
            file_sha256: sha256_hex(text.as_bytes()),
            bytes: text.as_bytes().to_vec(),
            embedding_config: EmbeddingConfig {
                model: "text-embedding-v3".to_string(),
                base_url: "http://localhost:11434/v1".to_string(),
                api_key: Some("test".to_string()),
                batch_size: 2,
                index_name: "chunks".to_string(),
                index_alias: "chunks_search".to_string(),
                enabled: false,
            },
            elasticsearch_url: None,
        }
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

async fn download_page_pdf(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath((doc_id, page)): AxumPath<(Uuid, u32)>,
) -> Result<Response, AppError> {
    require_permission(&actor, "document.upload")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档页预览需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let row = sqlx::query(
        "SELECT storage_key FROM documents WHERE tenant_id = $1 AND id = $2",
    )
    .bind(actor.tenant_id)
    .bind(doc_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound {
        code: "DOCUMENT_NOT_FOUND".to_string(),
        message: "文档不存在或无权限".to_string(),
    })?;
    let storage_key: String = row.get("storage_key");

    let base_dir = Path::new(&state.config.blob_storage_dir);
    let cache_dir = base_dir
        .parent()
        .unwrap_or(base_dir)
        .join("page_pdfs")
        .join(doc_id.to_string());
    let cache_path = cache_dir.join(format!("{}.pdf", page));

    let total_path = cache_dir.join("total_pages.txt");

    if !cache_path.exists() {
        tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| {
            AppError::Internal(anyhow::anyhow!(
                "failed to create page pdf cache dir: {}",
                e
            ))
        })?;

        let pdf_bytes = state.storage.get(&storage_key).await?;
        let (single_page, total_pages) = tokio::task::spawn_blocking(move || {
            extract_single_page_pdf(&pdf_bytes, page)
        })
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("page extraction task failed: {:?}", e)))??;

        let tmp_path = cache_path.with_extension("tmp");
        tokio::fs::write(&tmp_path, &single_page)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to write temp page pdf: {}", e)))?;
        tokio::fs::rename(&tmp_path, &cache_path)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to finalize page pdf: {}", e)))?;
        tokio::fs::write(&total_path, total_pages.to_string())
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to write total pages: {}", e)))?;
    }

    let bytes = tokio::fs::read(&cache_path).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!("failed to read cached page pdf: {}", e))
    })?;
    let total_pages = tokio::fs::read_to_string(&total_path)
        .await
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    headers.insert(
        "Access-Control-Expose-Headers",
        HeaderValue::from_static("X-Total-Pages"),
    );
    if total_pages > 0 {
        headers.insert(
            "X-Total-Pages",
            HeaderValue::from_str(&total_pages.to_string()).unwrap_or_else(|_| HeaderValue::from_static("0")),
        );
    }
    Ok((StatusCode::OK, headers, bytes).into_response())
}

fn extract_single_page_pdf(pdf_bytes: &[u8], page: u32) -> anyhow::Result<(Vec<u8>, u32)> {
    use anyhow::{bail, Context};
    use lopdf::{Document, Object};

    let mut doc = Document::load_mem(pdf_bytes)?;
    let pages = doc.get_pages();
    let total = pages.len() as u32;
    if page < 1 || page > total {
        bail!("page {} out of range (1-{})", page, total);
    }
    let target_id = *pages
        .get(&page)
        .with_context(|| format!("page {} not found", page))?;

    let catalog = doc.catalog()?.clone();
    let root_pages_ref = catalog
        .get(b"Pages")
        .context("missing Pages entry in catalog")?
        .as_reference()
        .context("Pages entry is not a reference")?;

    for (num, id) in pages.iter() {
        if *num != page {
            doc.delete_object(*id);
        }
    }

    let intermediate_pages: Vec<lopdf::ObjectId> = doc
        .objects
        .iter()
        .filter(|(id, _)| **id != root_pages_ref)
        .filter_map(|(id, obj)| {
            if let Ok(dict) = obj.as_dict() {
                if dict.get(b"Type").ok()?.as_name().ok() == Some(b"Pages") {
                    return Some(*id);
                }
            }
            None
        })
        .collect();
    for id in intermediate_pages {
        doc.delete_object(id);
    }

    if let Ok(root_pages) = doc.get_object_mut(root_pages_ref)?.as_dict_mut() {
        root_pages.set(
            "Kids",
            Object::Array(vec![Object::Reference(target_id)]),
        );
        root_pages.set("Count", Object::Integer(1));
    }
    if let Ok(page_obj) = doc.get_object_mut(target_id)?.as_dict_mut() {
        page_obj.set("Parent", Object::Reference(root_pages_ref));
    }

    doc.prune_objects();
    doc.renumber_objects();
    doc.compress();

    let mut output = Vec::new();
    doc.save_to(&mut output)?;
    Ok((output, total))
}
