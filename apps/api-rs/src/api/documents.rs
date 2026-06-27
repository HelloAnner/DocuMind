use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use tokio::process::Command;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::auth::{
    actor_from_bearer_token, record_audit_event, require_kb_permission, require_permission,
    ActorExtractor,
};
use crate::config::EmbeddingConfig;
use crate::document::{self as ingest, cleaning::cleaned_block_metadata};
use crate::error::AppError;
use crate::rag::embedding::{EmbeddingClient, EmbeddingClientConfig};
use crate::rag::vector_index::{
    ElasticsearchChunkIndexer, ElasticsearchConfig, EsRange, IndexedChunk,
};
use crate::state::AppState;
use crate::{models::NormalizedBBox, models::SourceAnchor};

const PARSER_VERSION: &str = ingest::PARSER_VERSION;
const PREVIEW_CHAR_LIMIT: usize = 60_000;
const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const OFFICE_CONVERSION_TIMEOUT_SECONDS: u64 = 90;
const OCR_RENDER_DPI: u32 = 220;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/knowledge-bases/:kb_id/documents",
            post(upload_document).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
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
        .route("/api/files/:doc_id/preview", get(get_file_preview))
        .route("/api/files/:doc_id/preview-url", get(get_file_preview_url))
        .route(
            "/api/files/:doc_id/preview/manifest",
            get(get_file_preview_manifest),
        )
        .route(
            "/api/files/:doc_id/preview/content",
            get(download_file_preview_content),
        )
        .route(
            "/api/files/:doc_id/preview/pages/:page/pdf",
            get(download_file_preview_page_pdf),
        )
        .route("/api/admin/documents/:doc_id/move", post(move_document))
        .route("/api/admin/documents/:doc_id/retry", post(retry_parse))
        .route(
            "/api/admin/documents/:doc_id/force-index",
            post(force_index_document),
        )
        .route(
            "/api/admin/documents/:doc_id/exclude-from-search",
            post(exclude_from_search),
        )
        .route(
            "/api/admin/documents/:doc_id/replace-file",
            post(replace_document_file).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route(
            "/api/admin/documents/:doc_id/send-to-ocr",
            post(send_to_ocr),
        )
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
struct ExcludeFromSearchResponse {
    document_id: Uuid,
    status: String,
    es_deleted_chunks: u64,
}

#[derive(Debug, Serialize)]
struct ReplaceDocumentFileResponse {
    document_id: Uuid,
    parse_job_id: Uuid,
    parse_status: String,
    parse_version: i32,
    title: String,
    file_type: String,
    file_sha256: String,
    storage_key: String,
}

#[derive(Debug, Serialize)]
struct SendToOcrResponse {
    document_id: Uuid,
    ocr_job_id: Uuid,
    parse_status: String,
    ocr_status: String,
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
struct FilePreviewResponse {
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
    file_name: String,
    format: String,
    preview_type: String,
    preview_url: String,
    manifest_url: String,
    source_status: String,
}

#[derive(Debug, Serialize)]
struct FilePreviewUrlResponse {
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
    file_name: String,
    format: String,
    preview_type: String,
    expires_at: DateTime<Utc>,
    expires_in_seconds: u64,
    preview_url: String,
    manifest_url: String,
    page_pdf_url_template: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FilePreviewAccessClaims {
    sub: Uuid,
    tenant_id: Uuid,
    doc_id: Uuid,
    scope: String,
    exp: usize,
}

#[derive(Debug, Deserialize)]
struct PreviewAccessQuery {
    preview_token: Option<String>,
}

#[derive(Debug, Serialize)]
struct FilePreviewManifest {
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
    file_name: String,
    format: String,
    preview_type: String,
    page_count: Option<i32>,
    pages: Vec<FilePreviewManifestPage>,
    text_layer_available: bool,
    conversion_status: String,
}

#[derive(Debug, Serialize)]
struct FilePreviewManifestPage {
    page: i32,
    width: f64,
    height: f64,
    rotation: i32,
    text_layer_available: bool,
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
    parse_status: String,
    latest_parse_job_id: Option<Uuid>,
    chunk_count: i32,
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
    parser_config: Value,
    parse_identity: String,
    bytes: Vec<u8>,
    embedding_config: EmbeddingConfig,
    elasticsearch_url: Option<String>,
    force_index: bool,
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

    record_audit_event(
        &state,
        Some(&actor),
        "document.upload",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "kb_id": kb_id,
            "file_name": uploaded.file_name.clone(),
            "title": uploaded.title.clone(),
            "file_type": file_type.clone(),
            "file_size": uploaded.bytes.len(),
            "parse_job_id": parse_job_id,
        }),
    )
    .await?;

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
            parser_config,
            parse_identity,
            bytes: uploaded.bytes,
            embedding_config: state.config.rag.embedding.clone(),
            elasticsearch_url: state.config.elasticsearch_url.clone(),
            force_index: false,
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
    record_audit_event(
        &state,
        Some(&actor),
        "document.delete",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "kb_id": doc.kb_id,
            "title": doc.title,
            "file_type": doc.file_type,
            "storage_key": doc.storage_key,
        }),
    )
    .await?;

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
    let resp = reprocess_or_retry_document(&state, &actor, doc_id, false, false).await?;
    record_audit_event(
        &state,
        Some(&actor),
        "document.reprocess",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "parse_job_id": resp.parse_job_id,
            "parse_version": resp.parse_version,
            "reused_existing_parse": resp.reused_existing_parse,
        }),
    )
    .await?;
    Ok(Json(resp))
}

async fn retry_parse(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<DocumentSummary>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let retry = reprocess_or_retry_document(&state, &actor, doc_id, true, false).await?;
    record_audit_event(
        &state,
        Some(&actor),
        "document.retry",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "parse_job_id": retry.parse_job_id,
            "parse_version": retry.parse_version,
        }),
    )
    .await?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档查询需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let summary = fetch_document_summary(pool, actor.tenant_id, doc_id).await?;
    Ok(Json(summary))
}

async fn force_index_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<ReprocessDocumentResponse>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let resp = reprocess_or_retry_document(&state, &actor, doc_id, true, true).await?;
    record_audit_event(
        &state,
        Some(&actor),
        "document.force_index",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "parse_job_id": resp.parse_job_id,
            "parse_version": resp.parse_version,
        }),
    )
    .await?;
    Ok(Json(resp))
}

async fn exclude_from_search(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<ExcludeFromSearchResponse>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档检索排除需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    require_kb_permission(&actor, doc.kb_id, "write")?;
    if doc.parse_status == "excluded_from_search" {
        return Ok(Json(ExcludeFromSearchResponse {
            document_id: doc_id,
            status: "excluded_from_search".to_string(),
            es_deleted_chunks: 0,
        }));
    }
    if !can_exclude_from_search(&doc.parse_status) {
        return Err(AppError::InvalidState {
            code: "EXCLUDE_FROM_SEARCH_NOT_ALLOWED".to_string(),
            message: "只有已完成、失败或低置信文档可以被排除出检索".to_string(),
        });
    }

    let deleted = delete_document_from_search_index(&state, &doc).await?;
    sqlx::query(
        "UPDATE documents
         SET parse_status = 'excluded_from_search',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(json!({
        "excluded_from_search": true,
        "excluded_from_search_at": Utc::now(),
        "excluded_from_search_by": actor.user_id,
        "previous_parse_status": doc.parse_status,
        "es_deleted_chunks": deleted,
        "parse_progress": 100,
    }))
    .bind(actor.tenant_id)
    .bind(doc_id)
    .execute(pool)
    .await?;

    record_audit_event(
        &state,
        Some(&actor),
        "document.exclude_from_search",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "kb_id": doc.kb_id,
            "title": doc.title,
            "previous_parse_status": doc.parse_status,
            "es_deleted_chunks": deleted,
        }),
    )
    .await?;

    Ok(Json(ExcludeFromSearchResponse {
        document_id: doc_id,
        status: "excluded_from_search".to_string(),
        es_deleted_chunks: deleted,
    }))
}

async fn replace_document_file(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<ReplaceDocumentFileResponse>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档替换需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    require_kb_permission(&actor, doc.kb_id, "write")?;
    if !can_replace_file(&doc.parse_status) {
        return Err(AppError::InvalidState {
            code: "REPLACE_FILE_NOT_ALLOWED".to_string(),
            message: "当前文档正在处理，不能替换文件".to_string(),
        });
    }

    let uploaded = read_multipart_file(&mut multipart).await?;
    let file_format =
        ingest::detect_file_type(&uploaded.file_name, &uploaded.mime_type, &uploaded.bytes)
            .map_err(|err| AppError::bad_request("UNSUPPORTED_FILE_TYPE", err.to_string()))?;
    let file_type = file_format.as_str().to_string();
    let file_sha256 = sha256_hex(&uploaded.bytes);
    if file_sha256 == doc.file_sha256 {
        return Err(AppError::bad_request(
            "REPLACEMENT_UNCHANGED",
            "替换文件内容与当前原文件一致",
        ));
    }

    let parse_job_id = Uuid::new_v4();
    let parse_version = doc.parse_version + 1;
    let storage_key =
        document_storage_key(actor.tenant_id, doc.kb_id, doc.id, &file_sha256, &file_type);
    let mut parser_config = current_parser_config();
    if let Some(config) = parser_config.as_object_mut() {
        config.insert("replacement_generation".to_string(), json!(parse_job_id));
    }
    let parse_identity = parse_identity_for(&file_sha256, &parser_config);

    state.storage.put(&storage_key, &uploaded.bytes).await?;
    let deleted_chunks = match delete_document_from_search_index(&state, &doc).await {
        Ok(deleted) => deleted,
        Err(err) => {
            let _ = state.storage.delete(&storage_key).await;
            return Err(err);
        }
    };

    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE documents
         SET title = $1,
             file_type = $2,
             file_size_bytes = $3,
             storage_key = $4,
             file_sha256 = $5,
             metadata = metadata || $6,
             updated_at = NOW()
         WHERE tenant_id = $7 AND id = $8",
    )
    .bind(&uploaded.title)
    .bind(&file_type)
    .bind(uploaded.bytes.len() as i64)
    .bind(&storage_key)
    .bind(&file_sha256)
    .bind(json!({
        "original_filename": uploaded.file_name.clone(),
        "mime_type": uploaded.mime_type.clone(),
        "replaced_file_at": Utc::now(),
        "replaced_file_by": actor.user_id,
        "previous_file_sha256": doc.file_sha256.clone(),
        "previous_storage_key": doc.storage_key.clone(),
        "previous_parse_status": doc.parse_status.clone(),
        "replacement_es_deleted_chunks": deleted_chunks,
    }))
    .bind(actor.tenant_id)
    .bind(doc.id)
    .execute(&mut *tx)
    .await?;
    insert_pending_parse_job(
        &mut tx,
        ParseWriteScope {
            tenant_id: actor.tenant_id,
            kb_id: doc.kb_id,
            doc_id: doc.id,
            parse_job_id,
            parse_version,
        },
        parser_config.clone(),
        parse_identity.clone(),
    )
    .await?;
    tx.commit().await?;

    if doc.storage_key != storage_key {
        let _ = state.storage.delete(&doc.storage_key).await;
    }

    record_audit_event(
        &state,
        Some(&actor),
        "document.replace_file",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "kb_id": doc.kb_id,
            "title": uploaded.title.clone(),
            "file_name": uploaded.file_name.clone(),
            "file_type": file_type.clone(),
            "file_size": uploaded.bytes.len(),
            "parse_job_id": parse_job_id,
            "parse_version": parse_version,
            "previous_file_sha256": doc.file_sha256.clone(),
            "previous_parse_status": doc.parse_status.clone(),
            "es_deleted_chunks": deleted_chunks,
        }),
    )
    .await?;

    spawn_parse_job(
        pool.clone(),
        ParseJobTask {
            tenant_id: actor.tenant_id,
            kb_id: doc.kb_id,
            doc_id: doc.id,
            parse_job_id,
            parse_version,
            title: uploaded.title.clone(),
            file_name: uploaded.file_name.clone(),
            mime_type: uploaded.mime_type.clone(),
            file_type: file_type.clone(),
            parser_config,
            parse_identity,
            bytes: uploaded.bytes,
            embedding_config: state.config.rag.embedding.clone(),
            elasticsearch_url: state.config.elasticsearch_url.clone(),
            force_index: false,
        },
    );

    Ok(Json(ReplaceDocumentFileResponse {
        document_id: doc.id,
        parse_job_id,
        parse_status: "uploaded".to_string(),
        parse_version,
        title: uploaded.title,
        file_type,
        file_sha256,
        storage_key,
    }))
}

async fn send_to_ocr(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<SendToOcrResponse>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "OCR 入队需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    require_kb_permission(&actor, doc.kb_id, "write")?;

    if doc.parse_status == "ocr_pending" {
        if let Some(ocr_job_id) = fetch_active_ocr_job_id(pool, actor.tenant_id, doc_id).await? {
            return Ok(Json(SendToOcrResponse {
                document_id: doc_id,
                ocr_job_id,
                parse_status: "ocr_pending".to_string(),
                ocr_status: "pending".to_string(),
            }));
        }
    }

    if !can_send_to_ocr(&doc.parse_status) {
        return Err(AppError::InvalidState {
            code: "SEND_TO_OCR_NOT_ALLOWED".to_string(),
            message: "只有低置信解析文档可以进入 OCR 增强队列".to_string(),
        });
    }
    if doc.file_type != "pdf" {
        return Err(AppError::InvalidState {
            code: "OCR_UNSUPPORTED_FILE_TYPE".to_string(),
            message: "当前仅支持 PDF 文档进入 OCR 增强队列".to_string(),
        });
    }
    let bytes = state.storage.get(&doc.storage_key).await.map_err(|e| {
        AppError::bad_request(
            "ORIGINAL_FILE_MISSING",
            format!("无法读取原始文件 {}: {e}", doc.storage_key),
        )
    })?;

    let ocr_job_id = Uuid::new_v4();
    let document_id = doc.id;
    let parse_version = doc.parse_version + 1;
    let mut parser_config = current_parser_config();
    if let Some(config) = parser_config.as_object_mut() {
        config.insert("job_kind".to_string(), json!("ocr"));
        config.insert("ocr_status".to_string(), json!("queued"));
        config.insert("ocr_engine".to_string(), json!("tesseract"));
        config.insert("ocr_render_dpi".to_string(), json!(OCR_RENDER_DPI));
        config.insert(
            "source_parse_job_id".to_string(),
            json!(doc.latest_parse_job_id),
        );
    }
    let parse_identity = format!("ocr:{}:{ocr_job_id}", doc.id);

    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO document_parse_jobs (
            parse_job_id, tenant_id, kb_id, doc_id, parser_version, parser_config,
            parse_identity, status, started_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ocr_queued', NOW())",
    )
    .bind(ocr_job_id)
    .bind(doc.tenant_id)
    .bind(doc.kb_id)
    .bind(doc.id)
    .bind(PARSER_VERSION)
    .bind(parser_config.clone())
    .bind(&parse_identity)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE documents
         SET parse_status = 'ocr_pending',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3",
    )
    .bind(json!({
        "ocr_status": "pending",
        "ocr_requested_at": Utc::now(),
        "ocr_requested_by": actor.user_id,
        "active_ocr_job_id": ocr_job_id,
        "ocr_source_parse_job_id": doc.latest_parse_job_id,
        "previous_parse_status": doc.parse_status,
        "parse_progress": 100,
    }))
    .bind(actor.tenant_id)
    .bind(doc.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    record_audit_event(
        &state,
        Some(&actor),
        "document.send_to_ocr",
        Some("document"),
        Some(&doc_id.to_string()),
        json!({
            "kb_id": doc.kb_id,
            "title": doc.title.clone(),
            "ocr_job_id": ocr_job_id,
            "source_parse_job_id": doc.latest_parse_job_id,
            "previous_parse_status": doc.parse_status,
        }),
    )
    .await?;

    spawn_parse_job(
        pool.clone(),
        ParseJobTask {
            tenant_id: doc.tenant_id,
            kb_id: doc.kb_id,
            doc_id: doc.id,
            parse_job_id: ocr_job_id,
            parse_version,
            title: doc.title,
            file_name: doc.file_name,
            mime_type: doc.mime_type,
            file_type: doc.file_type,
            parser_config,
            parse_identity,
            bytes,
            embedding_config: state.config.rag.embedding.clone(),
            elasticsearch_url: state.config.elasticsearch_url.clone(),
            force_index: false,
        },
    );

    Ok(Json(SendToOcrResponse {
        document_id,
        ocr_job_id,
        parse_status: "ocr_pending".to_string(),
        ocr_status: "pending".to_string(),
    }))
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
    let doc_ids = req.doc_ids;
    for doc_id in &doc_ids {
        reprocess_or_retry_document(&state, &actor, *doc_id, true, false).await?;
        retried += 1;
    }
    record_audit_event(
        &state,
        Some(&actor),
        "document.retry_batch",
        Some("document"),
        None,
        json!({
            "doc_ids": doc_ids,
            "retried": retried,
        }),
    )
    .await?;
    Ok(Json(json!({ "retried": retried })))
}

fn can_exclude_from_search(parse_status: &str) -> bool {
    matches!(
        parse_status,
        "indexed" | "parse_low_confidence" | "parse_failed" | "embedding_failed"
    )
}

fn can_replace_file(parse_status: &str) -> bool {
    matches!(
        parse_status,
        "indexed"
            | "parse_low_confidence"
            | "parse_failed"
            | "embedding_failed"
            | "excluded_from_search"
    )
}

fn can_send_to_ocr(parse_status: &str) -> bool {
    parse_status == "parse_low_confidence"
}

fn document_storage_key(
    tenant_id: Uuid,
    kb_id: Uuid,
    doc_id: Uuid,
    file_sha256: &str,
    file_type: &str,
) -> String {
    format!(
        "tenants/{tenant_id}/knowledge-bases/{kb_id}/documents/{doc_id}/original/{file_sha256}.{file_type}"
    )
}

async fn delete_document_from_search_index(
    state: &AppState,
    doc: &DocumentRecord,
) -> Result<u64, AppError> {
    let Some(elasticsearch_url) = state.config.elasticsearch_url.clone() else {
        if doc.parse_status == "indexed" || doc.chunk_count > 0 {
            return Err(AppError::bad_request(
                "ELASTICSEARCH_REQUIRED",
                "排除已切片文档需要可用的 Elasticsearch 配置",
            ));
        }
        return Ok(0);
    };
    let indexer = ElasticsearchChunkIndexer::new(ElasticsearchConfig {
        base_url: elasticsearch_url,
        index_name: state.config.rag.embedding.index_name.clone(),
        alias_name: state.config.rag.embedding.index_alias.clone(),
        timeout_seconds: 120,
    })?;
    indexer
        .delete_document_chunks(doc.id)
        .await
        .map_err(AppError::from)
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
            OR ($3 = 'failed' AND d.parse_status IN (
                'parse_failed',
                'parse_low_confidence',
                'ocr_pending',
                'embedding_failed',
                'parsing',
                'parsed'
            ))
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

async fn get_file_preview(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<FilePreviewResponse>, AppError> {
    let doc = fetch_readable_document(&state, &actor, doc_id).await?;
    let preview_type = preview_type_for(&doc.file_type);
    Ok(Json(FilePreviewResponse {
        doc_id: doc.id,
        parse_job_id: doc.latest_parse_job_id,
        file_name: doc.file_name,
        format: doc.file_type,
        preview_type,
        preview_url: format!("/api/files/{doc_id}/preview/content"),
        manifest_url: format!("/api/files/{doc_id}/preview/manifest"),
        source_status: source_status_for(&doc.parse_status).to_string(),
    }))
}

async fn get_file_preview_url(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    AxumPath(doc_id): AxumPath<Uuid>,
) -> Result<Json<FilePreviewUrlResponse>, AppError> {
    let doc = fetch_readable_document(&state, &actor, doc_id).await?;
    let expires_in_seconds = state.config.object_storage_presign_expire_seconds;
    let expires_at =
        Utc::now() + ChronoDuration::seconds(i64::try_from(expires_in_seconds).unwrap_or(i64::MAX));
    let token = encode_preview_access_token(&state, &actor, doc.id, expires_at)?;
    let preview_type = preview_type_for(&doc.file_type);
    Ok(Json(FilePreviewUrlResponse {
        doc_id: doc.id,
        parse_job_id: doc.latest_parse_job_id,
        file_name: doc.file_name,
        format: doc.file_type,
        preview_type,
        expires_at,
        expires_in_seconds,
        preview_url: signed_preview_url(&format!("/api/files/{doc_id}/preview/content"), &token),
        manifest_url: signed_preview_url(&format!("/api/files/{doc_id}/preview/manifest"), &token),
        page_pdf_url_template: signed_preview_url(
            &format!("/api/files/{doc_id}/preview/pages/{{page}}/pdf"),
            &token,
        ),
    }))
}

async fn get_file_preview_manifest(
    State(state): State<AppState>,
    Query(query): Query<PreviewAccessQuery>,
    AxumPath(doc_id): AxumPath<Uuid>,
    headers: HeaderMap,
) -> Result<Json<FilePreviewManifest>, AppError> {
    let doc =
        fetch_preview_document(&state, &headers, doc_id, query.preview_token.as_deref()).await?;
    let page_count = fetch_preview_page_count(&state, &doc).await?;
    let preview_type = preview_type_for(&doc.file_type);
    let text_layer_available = matches!(doc.file_type.as_str(), "pdf" | "txt" | "md");
    let conversion_status = if is_office_preview_type(&doc.file_type) {
        "converted"
    } else {
        "original"
    };
    let pages = page_count
        .filter(|count| *count > 0)
        .map(|count| {
            (1..=count)
                .map(|page| FilePreviewManifestPage {
                    page,
                    width: 595.28,
                    height: 841.89,
                    rotation: 0,
                    text_layer_available,
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(FilePreviewManifest {
        doc_id: doc.id,
        parse_job_id: doc.latest_parse_job_id,
        file_name: doc.file_name,
        format: doc.file_type,
        preview_type,
        page_count,
        pages,
        text_layer_available,
        conversion_status: conversion_status.to_string(),
    }))
}

async fn download_file_preview_page_pdf(
    State(state): State<AppState>,
    Query(query): Query<PreviewAccessQuery>,
    AxumPath((doc_id, page)): AxumPath<(Uuid, u32)>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let doc =
        fetch_preview_document(&state, &headers, doc_id, query.preview_token.as_deref()).await?;
    if doc.file_type == "pdf" {
        return download_pdf_page_from_document(&state, &doc, page).await;
    }
    if is_office_preview_type(&doc.file_type) {
        return download_office_pdf_page_from_document(&state, &doc, page).await;
    }
    Err(AppError::bad_request(
        "PREVIEW_PAGE_UNSUPPORTED",
        "当前文件类型不支持按页预览",
    ))
}

async fn download_file_preview_content(
    State(state): State<AppState>,
    AxumPath(doc_id): AxumPath<Uuid>,
    Query(query): Query<PreviewAccessQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let doc =
        fetch_preview_document(&state, &headers, doc_id, query.preview_token.as_deref()).await?;
    if is_office_preview_type(&doc.file_type) {
        return download_office_preview_pdf(&state, &doc).await;
    }
    download_document_content(&state, &doc, &headers, true).await
}

async fn download_office_preview_pdf(
    state: &AppState,
    doc: &DocumentRecord,
) -> Result<Response, AppError> {
    let pdf_path = ensure_office_preview_pdf(state, doc).await?;
    let bytes = tokio::fs::read(&pdf_path).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!("failed to read office preview pdf: {}", e))
    })?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "inline; filename=\"{}.pdf\"",
            sanitize_file_name(&doc.title)
        ))
        .unwrap_or_else(|_| HeaderValue::from_static("inline")),
    );
    Ok((StatusCode::OK, headers, bytes).into_response())
}

async fn download_office_pdf_page_from_document(
    state: &AppState,
    doc: &DocumentRecord,
    page: u32,
) -> Result<Response, AppError> {
    let pdf_path = ensure_office_preview_pdf(state, doc).await?;
    download_pdf_page_from_path(state, doc, page, &pdf_path).await
}

async fn download_pdf_page_from_path(
    state: &AppState,
    doc: &DocumentRecord,
    page: u32,
    pdf_path: &Path,
) -> Result<Response, AppError> {
    let cache_dir = preview_cache_root(state)
        .join("page_pdfs")
        .join(doc.id.to_string())
        .join(preview_cache_version(doc))
        .join(source_file_hash(pdf_path));
    let cache_path = cache_dir.join(format!("{}.pdf", page));
    let total_path = cache_dir.join("total_pages.txt");

    if !cache_path.exists() {
        tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| {
            AppError::Internal(anyhow::anyhow!(
                "failed to create page pdf cache dir: {}",
                e
            ))
        })?;

        let pdf_bytes = tokio::fs::read(pdf_path).await.map_err(|e| {
            AppError::Internal(anyhow::anyhow!("failed to read source preview pdf: {}", e))
        })?;
        let (single_page, total_pages) =
            tokio::task::spawn_blocking(move || extract_single_page_pdf(&pdf_bytes, page))
                .await
                .map_err(|e| {
                    AppError::Internal(anyhow::anyhow!("page extraction task failed: {:?}", e))
                })??;

        let tmp_path = cache_path.with_extension("tmp");
        tokio::fs::write(&tmp_path, &single_page)
            .await
            .map_err(|e| {
                AppError::Internal(anyhow::anyhow!("failed to write temp page pdf: {}", e))
            })?;
        tokio::fs::rename(&tmp_path, &cache_path)
            .await
            .map_err(|e| {
                AppError::Internal(anyhow::anyhow!("failed to finalize page pdf: {}", e))
            })?;
        tokio::fs::write(&total_path, total_pages.to_string())
            .await
            .map_err(|e| {
                AppError::Internal(anyhow::anyhow!("failed to write total pages: {}", e))
            })?;
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
            HeaderValue::from_str(&total_pages.to_string())
                .unwrap_or_else(|_| HeaderValue::from_static("0")),
        );
    }
    Ok((StatusCode::OK, headers, bytes).into_response())
}

async fn ensure_office_preview_pdf(
    state: &AppState,
    doc: &DocumentRecord,
) -> Result<PathBuf, AppError> {
    if !is_office_preview_type(&doc.file_type) {
        return Err(AppError::bad_request(
            "OFFICE_PREVIEW_UNSUPPORTED",
            "当前文件类型不支持 Office PDF 预览",
        ));
    }

    let cache_dir = preview_cache_root(state)
        .join("office_pdfs")
        .join(doc.id.to_string())
        .join(preview_cache_version(doc));
    let pdf_path = cache_dir.join("converted.pdf");
    if pdf_path.exists() {
        return Ok(pdf_path);
    }

    tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!(
            "failed to create office preview cache dir: {}",
            e
        ))
    })?;

    let bytes = state.storage.get(&doc.storage_key).await?;
    let input_path = cache_dir.join(format!("source.{}", doc.file_type));
    tokio::fs::write(&input_path, bytes).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!(
            "failed to write office preview source: {}",
            e
        ))
    })?;

    let output_path = convert_office_to_pdf(&input_path, &cache_dir).await?;
    let tmp_path = pdf_path.with_extension("tmp");
    tokio::fs::rename(&output_path, &tmp_path)
        .await
        .map_err(|e| {
            AppError::Internal(anyhow::anyhow!(
                "failed to stage converted office pdf: {}",
                e
            ))
        })?;
    tokio::fs::rename(&tmp_path, &pdf_path).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!(
            "failed to finalize converted office pdf: {}",
            e
        ))
    })?;
    Ok(pdf_path)
}

async fn convert_office_to_pdf(input_path: &Path, output_dir: &Path) -> Result<PathBuf, AppError> {
    let profile_dir = output_dir.join("lo-profile");
    tokio::fs::create_dir_all(&profile_dir).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!(
            "failed to create LibreOffice profile dir: {}",
            e
        ))
    })?;

    let output_pdf = output_dir.join(
        input_path
            .file_stem()
            .and_then(|name| name.to_str())
            .map(|name| format!("{name}.pdf"))
            .unwrap_or_else(|| "source.pdf".to_string()),
    );
    if output_pdf.exists() {
        let _ = tokio::fs::remove_file(&output_pdf).await;
    }

    let mut last_error: Option<String> = None;
    for command_name in ["soffice", "libreoffice"] {
        let mut command = Command::new(command_name);
        command
            .arg("--headless")
            .arg("--nologo")
            .arg("--nofirststartwizard")
            .arg("--nodefault")
            .arg("--nolockcheck")
            .arg(format!(
                "-env:UserInstallation=file://{}",
                profile_dir.display()
            ))
            .arg("--convert-to")
            .arg("pdf")
            .arg("--outdir")
            .arg(output_dir)
            .arg(input_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        match timeout(
            Duration::from_secs(OFFICE_CONVERSION_TIMEOUT_SECONDS),
            command.output(),
        )
        .await
        {
            Ok(Ok(output)) if output.status.success() && output_pdf.exists() => {
                return Ok(output_pdf);
            }
            Ok(Ok(output)) => {
                last_error = Some(format!(
                    "{} exited with status {:?}: stdout={} stderr={}",
                    command_name,
                    output.status.code(),
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Ok(Err(error)) => {
                last_error = Some(format!("failed to execute {command_name}: {error}"));
            }
            Err(_) => {
                last_error = Some(format!(
                    "{command_name} timed out after {}s",
                    OFFICE_CONVERSION_TIMEOUT_SECONDS
                ));
            }
        }
    }

    Err(AppError::Internal(anyhow::anyhow!(
        "office preview conversion failed: {}",
        last_error.unwrap_or_else(|| "LibreOffice executable not found".to_string())
    )))
}

fn preview_cache_root(state: &AppState) -> PathBuf {
    let base_dir = Path::new(&state.config.blob_storage_dir);
    base_dir.parent().unwrap_or(base_dir).join("preview_cache")
}

fn preview_cache_version(doc: &DocumentRecord) -> String {
    doc.latest_parse_job_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| doc.file_sha256.clone())
}

fn source_file_hash(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

fn is_office_preview_type(file_type: &str) -> bool {
    matches!(file_type, "docx" | "pptx")
}

async fn office_preview_page_count(
    state: &AppState,
    doc: &DocumentRecord,
) -> Result<Option<i32>, AppError> {
    if !is_office_preview_type(&doc.file_type) {
        return Ok(None);
    }
    let pdf_path = ensure_office_preview_pdf(state, doc).await?;
    let pdf_bytes = tokio::fs::read(pdf_path).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!("failed to read office preview pdf: {}", e))
    })?;
    let total_pages = tokio::task::spawn_blocking(move || pdf_page_count(&pdf_bytes))
        .await
        .map_err(|e| {
            AppError::Internal(anyhow::anyhow!("pdf page count task failed: {:?}", e))
        })??;
    Ok(Some(total_pages as i32))
}

async fn download_pdf_page_from_document(
    state: &AppState,
    doc: &DocumentRecord,
    page: u32,
) -> Result<Response, AppError> {
    if doc.file_type != "pdf" {
        return Err(AppError::bad_request(
            "PREVIEW_PAGE_UNSUPPORTED",
            "只有 PDF 原文支持按页预览",
        ));
    }
    let base_dir = Path::new(&state.config.blob_storage_dir);
    let pdf_path = base_dir.join(&doc.storage_key);
    if pdf_path.exists() {
        return download_pdf_page_from_path(state, doc, page, &pdf_path).await;
    }

    let cache_dir = preview_cache_root(state)
        .join("source_pdfs")
        .join(doc.id.to_string())
        .join(preview_cache_version(doc));
    let source_path = cache_dir.join("source.pdf");
    if !source_path.exists() {
        tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| {
            AppError::Internal(anyhow::anyhow!(
                "failed to create source pdf cache dir: {}",
                e
            ))
        })?;
        let bytes = state.storage.get(&doc.storage_key).await?;
        let tmp_path = source_path.with_extension("tmp");
        tokio::fs::write(&tmp_path, &bytes).await.map_err(|e| {
            AppError::Internal(anyhow::anyhow!("failed to write temp source pdf: {}", e))
        })?;
        tokio::fs::rename(&tmp_path, &source_path)
            .await
            .map_err(|e| {
                AppError::Internal(anyhow::anyhow!("failed to finalize source pdf: {}", e))
            })?;
    }
    download_pdf_page_from_path(state, doc, page, &source_path).await
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

async fn fetch_readable_document(
    state: &AppState,
    actor: &crate::models::CurrentActor,
    doc_id: Uuid,
) -> Result<DocumentRecord, AppError> {
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文件预览需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    require_kb_permission(actor, doc.kb_id, "read")?;
    if doc.parse_status == "excluded_from_search" {
        return Err(AppError::InvalidState {
            code: "DOCUMENT_EXCLUDED_FROM_SEARCH".to_string(),
            message: "文档已排除检索，原文预览不可用于问答来源".to_string(),
        });
    }
    Ok(doc)
}

async fn fetch_preview_document(
    state: &AppState,
    headers: &HeaderMap,
    doc_id: Uuid,
    preview_token: Option<&str>,
) -> Result<DocumentRecord, AppError> {
    if let Some(actor) = actor_from_bearer_token(state, headers).await? {
        return fetch_readable_document(state, &actor, doc_id).await;
    }

    let token = preview_token.ok_or_else(AppError::unauthorized)?;
    let claims = decode_preview_access_token(state, token)?;
    if claims.doc_id != doc_id || claims.scope != "file.preview.read" {
        return Err(AppError::Forbidden {
            code: "PREVIEW_TOKEN_SCOPE_DENIED".to_string(),
            message: "预览链接无权访问该文件".to_string(),
        });
    }
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文件预览需要启用 PostgreSQL 数据库连接",
        )
    })?;
    let doc = fetch_document(pool, claims.tenant_id, doc_id).await?;
    if doc.parse_status == "excluded_from_search" {
        return Err(AppError::InvalidState {
            code: "DOCUMENT_EXCLUDED_FROM_SEARCH".to_string(),
            message: "文档已排除检索，原文预览不可用于问答来源".to_string(),
        });
    }
    Ok(doc)
}

fn encode_preview_access_token(
    state: &AppState,
    actor: &crate::models::CurrentActor,
    doc_id: Uuid,
    expires_at: DateTime<Utc>,
) -> Result<String, AppError> {
    let claims = FilePreviewAccessClaims {
        sub: actor.user_id,
        tenant_id: actor.tenant_id,
        doc_id,
        scope: "file.preview.read".to_string(),
        exp: usize::try_from(expires_at.timestamp()).map_err(|_| {
            AppError::bad_request("PREVIEW_TOKEN_EXP_INVALID", "预览链接过期时间无效")
        })?,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to sign preview token: {}", e)))
}

fn decode_preview_access_token(
    state: &AppState,
    token: &str,
) -> Result<FilePreviewAccessClaims, AppError> {
    decode::<FilePreviewAccessClaims>(
        token,
        &DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized {
        code: "PREVIEW_TOKEN_INVALID".to_string(),
        message: "预览链接无效或已过期".to_string(),
    })
}

fn signed_preview_url(path: &str, token: &str) -> String {
    format!("{path}?preview_token={token}")
}

async fn fetch_preview_page_count(
    state: &AppState,
    doc: &DocumentRecord,
) -> Result<Option<i32>, AppError> {
    if is_office_preview_type(&doc.file_type) {
        return office_preview_page_count(state, doc).await;
    }

    if let (Some(pool), Some(parse_job_id)) = (state.db_pool.as_ref(), doc.latest_parse_job_id) {
        let page_count: Option<i32> = sqlx::query_scalar(
            "SELECT COALESCE((parser_config->>'page_count')::int, NULL)::int
             FROM document_parse_jobs
             WHERE parse_job_id = $1",
        )
        .bind(parse_job_id)
        .fetch_optional(pool)
        .await?
        .flatten();
        if page_count.is_some() {
            return Ok(page_count);
        }
    }

    if doc.file_type == "pdf" {
        let pdf_bytes = state.storage.get(&doc.storage_key).await?;
        let total_pages = tokio::task::spawn_blocking(move || pdf_page_count(&pdf_bytes))
            .await
            .map_err(|e| {
                AppError::Internal(anyhow::anyhow!("pdf page count task failed: {:?}", e))
            })??;
        return Ok(Some(total_pages as i32));
    }

    Ok(None)
}

fn preview_type_for(file_type: &str) -> String {
    match file_type {
        "pdf" => "pdf",
        "txt" | "md" => "text",
        "pptx" | "docx" => "office_pdf",
        _ => "original",
    }
    .to_string()
}

fn source_status_for(parse_status: &str) -> &'static str {
    match parse_status {
        "parse_failed" | "embedding_failed" => "degraded",
        "parse_low_confidence" | "ocr_pending" => "low_confidence",
        _ => "available",
    }
}

fn mime_type_for_document(doc: &DocumentRecord) -> &'static str {
    match doc.file_type.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "md" => "text/markdown; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn download_document_content(
    state: &AppState,
    doc: &DocumentRecord,
    req_headers: &HeaderMap,
    inline: bool,
) -> Result<Response, AppError> {
    let total_size = state.storage.size(&doc.storage_key).await?;
    let content_type = HeaderValue::from_static(mime_type_for_document(doc));

    if let Some(range) = req_headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        if let Some((start, end)) = parse_byte_range(range, total_size) {
            let bytes = state
                .storage
                .get_range(&doc.storage_key, start, end)
                .await?;
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, content_type);
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

    let bytes = state.storage.get(&doc.storage_key).await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let disposition = if inline { "inline" } else { "attachment" };
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "{disposition}; filename=\"{}\"",
            sanitize_file_name(&doc.file_name)
        ))
        .unwrap_or_else(|_| HeaderValue::from_static("inline")),
    );
    Ok((StatusCode::OK, headers, bytes).into_response())
}

// ---------------------------------------------------------------------------
// Shared reprocess / retry logic
// ---------------------------------------------------------------------------

pub async fn recover_interrupted_document_jobs(pool: &sqlx::PgPool) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        WITH candidates AS MATERIALIZED (
            SELECT
                d.id AS doc_id,
                d.tenant_id,
                COALESCE(
                    CASE
                        WHEN d.parse_status = 'ocr_pending'
                         AND COALESCE(d.metadata->>'active_ocr_job_id', '') ~* '^[0-9a-f-]{36}$'
                        THEN (d.metadata->>'active_ocr_job_id')::uuid
                    END,
                    CASE
                        WHEN COALESCE(d.metadata->>'active_parse_job_id', '') ~* '^[0-9a-f-]{36}$'
                        THEN (d.metadata->>'active_parse_job_id')::uuid
                    END,
                    d.latest_parse_job_id
                ) AS parse_job_id,
                d.parse_status,
                d.latest_parse_job_id
            FROM documents d
            WHERE d.parse_status IN ('uploaded', 'parsing', 'chunked', 'embedding', 'ocr_pending')
        ),
        interrupted AS MATERIALIZED (
            SELECT
                c.doc_id,
                c.tenant_id,
                c.parse_job_id,
                c.parse_status,
                COALESCE(j.parser_config->>'job_kind', 'parse') AS job_kind
            FROM candidates c
            LEFT JOIN document_parse_jobs j
                   ON j.parse_job_id = c.parse_job_id
            WHERE c.parse_job_id IS NOT NULL
              AND COALESCE(j.status, 'pending') IN ('pending', 'running', 'ocr_queued')
        ),
        updated_jobs AS (
            UPDATE document_parse_jobs j
               SET status = 'failed',
                   error_code = 'RUNTIME_INTERRUPTED',
                   error_message = 'DocuMind restarted before this in-process document job completed; retry the document to resume processing.',
                   completed_at = COALESCE(j.completed_at, NOW()),
                   finished_at = COALESCE(j.finished_at, NOW())
              FROM interrupted i
             WHERE j.parse_job_id = i.parse_job_id
             RETURNING j.parse_job_id
        )
        UPDATE documents d
           SET parse_status = CASE
                    WHEN i.parse_status = 'embedding' THEN 'embedding_failed'
                    WHEN i.parse_status = 'ocr_pending' OR i.job_kind = 'ocr' THEN 'parse_low_confidence'
                    ELSE 'parse_failed'
               END,
               metadata = d.metadata
                   || jsonb_build_object(
                       'active_parse_job_id', i.parse_job_id,
                       'parse_progress', 100,
                       'error_code', 'RUNTIME_INTERRUPTED',
                       'error_message', 'DocuMind restarted before this in-process document job completed; retry the document to resume processing.',
                       'recovered_at', NOW()
                   )
                   || CASE
                       WHEN i.parse_status = 'ocr_pending' OR i.job_kind = 'ocr'
                       THEN jsonb_build_object('ocr_status', 'failed')
                       ELSE '{}'::jsonb
                   END,
               updated_at = NOW()
          FROM interrupted i
         WHERE d.id = i.doc_id
        "#,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
fn interrupted_document_final_status(parse_status: &str, job_kind: &str) -> &'static str {
    if parse_status == "embedding" {
        "embedding_failed"
    } else if parse_status == "ocr_pending" || job_kind == "ocr" {
        "parse_low_confidence"
    } else {
        "parse_failed"
    }
}

async fn reprocess_or_retry_document(
    state: &AppState,
    actor: &crate::models::identity::CurrentActor,
    doc_id: Uuid,
    force: bool,
    force_index: bool,
) -> Result<ReprocessDocumentResponse, AppError> {
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::bad_request(
            "DATABASE_REQUIRED",
            "文档重解析需要启用 PostgreSQL 数据库连接",
        )
    })?;

    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    require_kb_permission(actor, doc.kb_id, "write")?;
    if force_index && doc.parse_status != "parse_low_confidence" {
        return Err(AppError::InvalidState {
            code: "FORCE_INDEX_NOT_ALLOWED".to_string(),
            message: "只有低置信解析文档可以由管理员确认后强制索引".to_string(),
        });
    }
    if force_index && doc.chunk_count <= 0 {
        return Err(AppError::InvalidState {
            code: "FORCE_INDEX_UNAVAILABLE".to_string(),
            message: "当前低置信文档没有有效切片，不能强制进入索引".to_string(),
        });
    }

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
        parser_config.clone(),
        parse_identity.clone(),
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
            parser_config,
            parse_identity,
            bytes,
            embedding_config: state.config.rag.embedding.clone(),
            elasticsearch_url: state.config.elasticsearch_url.clone(),
            force_index,
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
                storage_key, file_sha256, parse_version, parse_status, latest_parse_job_id, chunk_count
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
        parse_status: row.get("parse_status"),
        latest_parse_job_id: row.get("latest_parse_job_id"),
        chunk_count: row.get("chunk_count"),
    })
}

async fn fetch_active_ocr_job_id(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    doc_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    let value: Option<String> = sqlx::query_scalar(
        "SELECT metadata->>'active_ocr_job_id'
         FROM documents
         WHERE tenant_id = $1 AND id = $2",
    )
    .bind(tenant_id)
    .bind(doc_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    Ok(value.and_then(|raw| Uuid::parse_str(&raw).ok()))
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
    let is_ocr = is_ocr_task(task);
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
         SET parse_status = $1,
             metadata = metadata || $2,
             updated_at = NOW()
         WHERE tenant_id = $3 AND id = $4",
    )
    .bind(if is_ocr { "ocr_pending" } else { "parsing" })
    .bind(parse_running_metadata(task))
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
    let is_ocr = is_ocr_task(task);
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
         SET parse_status = $1,
             chunk_count = 0,
             metadata = metadata || $2,
             updated_at = NOW()
         WHERE tenant_id = $3 AND id = $4",
    )
    .bind(if is_ocr {
        "parse_low_confidence"
    } else {
        "parse_failed"
    })
    .bind(parse_failed_metadata(task, &error_code, &error_message))
    .bind(task.tenant_id)
    .bind(task.doc_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

fn parse_running_metadata(task: &ParseJobTask) -> Value {
    let is_ocr = is_ocr_task(task);
    let mut metadata = json!({
        "active_parse_job_id": task.parse_job_id,
        "parse_progress": if is_ocr { 45 } else { 30 },
    });
    if is_ocr {
        if let Some(object) = metadata.as_object_mut() {
            object.insert("ocr_status".to_string(), json!("running"));
        }
    }
    metadata
}

fn parse_failed_metadata(task: &ParseJobTask, error_code: &str, error_message: &str) -> Value {
    let is_ocr = is_ocr_task(task);
    let mut metadata = json!({
        "active_parse_job_id": task.parse_job_id,
        "parse_progress": 100,
        "error_code": error_code,
        "error_message": error_message,
    });
    if is_ocr {
        if let Some(object) = metadata.as_object_mut() {
            object.insert("ocr_status".to_string(), json!("failed"));
        }
    }
    metadata
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
        .bind(serde_json::to_value(&anchor.cell_range).unwrap_or(Value::Null))
        .bind(serde_json::to_value(&anchor.char_range).unwrap_or(Value::Null))
        .bind(serde_json::to_value(&anchor.bbox).unwrap_or(Value::Null))
        .bind(&anchor.source_ref)
        .bind(&anchor.text)
        .bind(&anchor.text_hash)
        .bind(&anchor.anchor_quality)
        .execute(&mut **tx)
        .await?;
    }

    let mut document_metadata = json!({
        "quality_score": artifacts.quality_score,
        "warnings": artifacts.bundle.parsed.warnings.clone(),
        "clean_stats": artifacts.bundle.clean_stats,
        "file_type": file_type,
    });
    if is_ocr_parser_config(&artifacts.parser_config) {
        if let Some(metadata) = document_metadata.as_object_mut() {
            metadata.insert("ocr_status".to_string(), json!("completed"));
            metadata.insert("ocr_completed_at".to_string(), json!(Utc::now()));
            metadata.insert("ocr_parse_job_id".to_string(), json!(scope.parse_job_id));
            metadata.insert(
                "ocr_block_count".to_string(),
                json!(artifacts.bundle.parsed.blocks.len()),
            );
            metadata.insert(
                "ocr_chunk_count".to_string(),
                json!(artifacts.bundle.chunks.len()),
            );
        }
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
    .bind(document_metadata)
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

            let primary_anchor = chunk.primary_anchor_id.and_then(|id| {
                artifacts
                    .bundle
                    .parsed
                    .anchors
                    .iter()
                    .find(|a| a.anchor_id == id)
            });

            indexed_chunks.push(IndexedChunk {
                chunk_id: chunk.chunk_id,
                doc_id: task.doc_id,
                doc_title: task.title.clone(),
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
                anchor_format: primary_anchor
                    .map(|a| a.format.clone())
                    .unwrap_or_else(|| chunk.source_type.clone()),
                anchor_kind: primary_anchor
                    .map(|a| a.kind.clone())
                    .unwrap_or_else(|| chunk.source_type.clone()),
                anchor_page: primary_anchor.and_then(|a| a.page),
                anchor_slide: primary_anchor.and_then(|a| a.slide),
                anchor_char_range: primary_anchor.and_then(|a| a.char_range.clone()),
                anchor_bbox: primary_anchor.and_then(|a| a.bbox.clone()),
                anchor_text: primary_anchor.map(|a| a.text.clone()).unwrap_or_default(),
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
    let mut bundle = if is_ocr_task(task) {
        build_ocr_bundle(task)?
    } else {
        ingest::parse_document(
            task.doc_id,
            task.parse_job_id,
            &task.file_name,
            &task.mime_type,
            &task.bytes,
        )
        .map_err(|err| AppError::bad_request("DOCUMENT_PARSE_FAILED", err.to_string()))?
    };
    bundle.parsed.title = task.title.clone();
    let scanned_pdf_no_text_layer = is_scanned_pdf_no_text_layer(&bundle);
    let ocr_task = is_ocr_task(task);

    if bundle.parsed.blocks.is_empty() && !scanned_pdf_no_text_layer {
        return Err(AppError::bad_request(
            "DOCUMENT_EMPTY",
            "未能从文档中提取到可检索文本",
        ));
    }

    if bundle.chunks.is_empty() && !scanned_pdf_no_text_layer {
        return Err(AppError::bad_request(
            "DOCUMENT_EMPTY",
            "文档解析成功但没有生成有效切片",
        ));
    }

    let parser_config = task.parser_config.clone();
    let parse_identity = task.parse_identity.clone();
    let quality_score = bundle.parsed.quality_score;
    let mut parse_status = if ocr_task {
        "chunked".to_string()
    } else if scanned_pdf_no_text_layer {
        "parse_low_confidence".to_string()
    } else {
        parse_status_for_quality(quality_score)?
    };
    if task.force_index && parse_status == "parse_low_confidence" {
        if bundle.chunks.is_empty() {
            return Err(AppError::InvalidState {
                code: "FORCE_INDEX_UNAVAILABLE".to_string(),
                message: "当前低置信文档没有有效切片，不能强制进入索引".to_string(),
            });
        }
        parse_status = "chunked".to_string();
    }
    let mut parser_config = parser_config;
    if let Some(config) = parser_config.as_object_mut() {
        config.insert(
            "warnings".to_string(),
            json!(bundle.parsed.warnings.clone()),
        );
        config.insert("quality_score".to_string(), json!(quality_score));
        config.insert("parse_status".to_string(), json!(parse_status.clone()));
        config.insert("force_index".to_string(), json!(task.force_index));
        if ocr_task {
            config.insert("ocr_status".to_string(), json!("completed"));
            config.insert("ocr_engine".to_string(), json!("tesseract"));
            config.insert("ocr_render_dpi".to_string(), json!(OCR_RENDER_DPI));
        }
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

fn build_ocr_bundle(task: &ParseJobTask) -> Result<ingest::ParsedBundle, AppError> {
    let work_dir = std::env::temp_dir().join(format!("documind-ocr-{}", task.parse_job_id));
    if work_dir.exists() {
        fs::remove_dir_all(&work_dir).map_err(|e| {
            AppError::Internal(anyhow::anyhow!("failed to reset ocr work dir: {}", e))
        })?;
    }
    fs::create_dir_all(&work_dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to create ocr work dir: {}", e)))?;

    let result = build_ocr_bundle_in_dir(task, &work_dir);
    let cleanup = fs::remove_dir_all(&work_dir);
    if let Err(cleanup_err) = cleanup {
        eprintln!(
            "failed to cleanup OCR work dir {}: {}",
            work_dir.display(),
            cleanup_err
        );
    }
    result
}

fn build_ocr_bundle_in_dir(
    task: &ParseJobTask,
    work_dir: &Path,
) -> Result<ingest::ParsedBundle, AppError> {
    let input_pdf = work_dir.join("source.pdf");
    fs::write(&input_pdf, &task.bytes).map_err(|e| {
        AppError::Internal(anyhow::anyhow!("failed to write ocr source pdf: {}", e))
    })?;

    let prefix = work_dir.join("page");
    let render_output = StdCommand::new("pdftoppm")
        .arg("-r")
        .arg(OCR_RENDER_DPI.to_string())
        .arg("-png")
        .arg(&input_pdf)
        .arg(&prefix)
        .output()
        .map_err(|e| {
            AppError::bad_request(
                "OCR_RENDER_UNAVAILABLE",
                format!("无法执行 pdftoppm，请检查 OCR 依赖: {e}"),
            )
        })?;
    if !render_output.status.success() {
        return Err(AppError::bad_request(
            "OCR_RENDER_FAILED",
            format!(
                "PDF 转图片失败: {}",
                String::from_utf8_lossy(&render_output.stderr)
            ),
        ));
    }

    let mut page_images = fs::read_dir(work_dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to list ocr pages: {}", e)))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("png"))
        .collect::<Vec<_>>();
    page_images.sort();

    if page_images.is_empty() {
        return Err(AppError::bad_request(
            "OCR_RENDER_EMPTY",
            "PDF 未能渲染出可 OCR 的页面",
        ));
    }

    let mut blocks = Vec::new();
    let mut anchors = Vec::new();
    let mut warnings = vec![
        "ocr_generated".to_string(),
        "scanned_pdf_no_text_layer".to_string(),
    ];
    let mut empty_pages = 0usize;

    for (page_idx, image_path) in page_images.iter().enumerate() {
        let page = (page_idx + 1) as i32;
        let output = StdCommand::new("tesseract")
            .arg(image_path)
            .arg("stdout")
            .arg("-l")
            .arg("chi_sim+eng")
            .arg("--psm")
            .arg("6")
            .output()
            .map_err(|e| {
                AppError::bad_request(
                    "OCR_ENGINE_UNAVAILABLE",
                    format!("无法执行 tesseract，请检查 OCR 依赖: {e}"),
                )
            })?;
        if !output.status.success() {
            return Err(AppError::bad_request(
                "OCR_ENGINE_FAILED",
                format!(
                    "Tesseract OCR 失败: {}",
                    String::from_utf8_lossy(&output.stderr)
                ),
            ));
        }

        let text = normalize_ocr_text(&String::from_utf8_lossy(&output.stdout));
        if text.is_empty() {
            empty_pages += 1;
            warnings.push(format!("ocr_page_{}_empty", page));
            continue;
        }

        let block_id = Uuid::new_v4();
        let bbox = NormalizedBBox::normalized(0.04, 0.06, 0.96, 0.94);
        let anchor = SourceAnchor::for_pdf_paragraph(
            task.doc_id,
            task.parse_job_id,
            task.tenant_id,
            block_id,
            page,
            &text,
            bbox.clone(),
        );
        let anchor_id = anchor.anchor_id;
        anchors.push(anchor);
        blocks.push(ingest::ParsedBlock {
            block_id,
            block_index: blocks.len() as i32,
            block_type: "paragraph".to_string(),
            text,
            heading_level: None,
            heading_path: vec![],
            page_start: Some(page),
            page_end: Some(page),
            slide_index: None,
            table_id: None,
            bbox: Some(json!(bbox)),
            anchor_ids: vec![anchor_id],
            source_ref: json!({"format": "pdf", "page": page, "source": "ocr"}),
            metadata: json!({
                "layout": "ocr",
                "ocr_engine": "tesseract",
                "ocr_render_dpi": OCR_RENDER_DPI,
            }),
        });
    }

    if blocks.is_empty() {
        return Err(AppError::bad_request(
            "OCR_EMPTY_TEXT",
            "OCR 未能识别出可检索文本",
        ));
    }

    let parsed = ingest::ParsedDocument {
        doc_id: task.doc_id,
        parse_job_id: task.parse_job_id,
        file_type: "pdf".to_string(),
        title: task.title.clone(),
        pages: Some(page_images.len() as i32),
        blocks,
        tables: vec![],
        anchors,
        warnings,
        quality_score: if empty_pages == 0 { 0.82 } else { 0.76 },
    };
    let (cleaned_blocks, clean_stats) =
        ingest::cleaning::clean_blocks(ingest::FileType::Pdf, &parsed.blocks);
    let chunk_cfg = ingest::ChunkConfig::default();
    let chunks = ingest::chunking::chunk_blocks(
        ingest::FileType::Pdf,
        task.kb_id,
        task.parse_job_id,
        &cleaned_blocks,
        &chunk_cfg,
    );
    if chunks.is_empty() {
        return Err(AppError::bad_request(
            "OCR_EMPTY_CHUNKS",
            "OCR 识别成功但没有生成有效切片",
        ));
    }

    Ok(ingest::ParsedBundle {
        file_type: ingest::FileType::Pdf,
        file_sha256: sha256_hex(&task.bytes),
        parsed,
        cleaned_blocks,
        clean_stats,
        chunks,
    })
}

fn normalize_ocr_text(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn is_ocr_task(task: &ParseJobTask) -> bool {
    is_ocr_parser_config(&task.parser_config)
}

fn is_ocr_parser_config(parser_config: &Value) -> bool {
    parser_config
        .get("job_kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "ocr")
}

fn current_parser_config() -> serde_json::Value {
    json!({
        "parser_version": PARSER_VERSION,
        "cleaner_version": ingest::CLEANER_VERSION,
        "chunker_version": ingest::CHUNKER_VERSION,
        "max_office_zip_entries": ingest::MAX_OFFICE_ZIP_ENTRIES,
        "max_office_uncompressed_bytes": ingest::MAX_OFFICE_UNCOMPRESSED_BYTES,
        "max_office_entry_bytes": ingest::MAX_OFFICE_ENTRY_BYTES,
        "max_office_xml_bytes": ingest::MAX_OFFICE_XML_BYTES,
        "max_office_compression_ratio": ingest::MAX_OFFICE_COMPRESSION_RATIO,
        "max_pdf_pages": ingest::MAX_PDF_PAGES,
        "max_pdf_page_text_chars": ingest::MAX_PDF_PAGE_TEXT_CHARS,
        "target_chunk_tokens": env_usize("RAG_TARGET_CHUNK_TOKENS", 800),
        "max_chunk_tokens": env_usize("RAG_MAX_CHUNK_TOKENS", 1500),
        "chunk_overlap_tokens": env_usize("RAG_CHUNK_OVERLAP_TOKENS", 200),
    })
}

fn is_scanned_pdf_no_text_layer(bundle: &ingest::ParsedBundle) -> bool {
    bundle.file_type == ingest::FileType::Pdf
        && bundle
            .parsed
            .warnings
            .iter()
            .any(|warning| warning == "scanned_pdf_no_text_layer")
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
        let table_anchor = bundle
            .parsed
            .anchors
            .iter()
            .find(|anchor| anchor.kind == "table_cell_range")
            .expect("table cell-range anchor should be generated");
        let cell_range = table_anchor
            .cell_range
            .as_ref()
            .expect("table anchor should include cell range");
        assert_eq!(cell_range.row_start, 0);
        assert_eq!(cell_range.row_end, 0);
        assert_eq!(cell_range.col_start, 0);
        assert_eq!(cell_range.col_end, 1);
        let table_block = bundle
            .parsed
            .blocks
            .iter()
            .find(|block| block.block_type == "table")
            .expect("table block should exist");
        assert!(table_block.anchor_ids.contains(&table_anchor.anchor_id));
        let table_chunk = bundle
            .chunks
            .iter()
            .find(|chunk| chunk.source_type == "table")
            .expect("table chunk should exist");
        assert!(table_chunk.anchor_ids.contains(&table_anchor.anchor_id));
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
    fn rejects_office_zip_with_too_many_entries() {
        let bytes = zip_with_many_entries(ingest::MAX_OFFICE_ZIP_ENTRIES + 1);

        let err = ingest::detect_file_type(
            "oversized.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            &bytes,
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("zip_entry_count_exceeded"));
    }

    #[test]
    fn rejects_office_zip_with_unsafe_entry_name() {
        let bytes = zip_with_entries(&[
            ("word/document.xml", "<w:document/>"),
            ("../outside.xml", "malicious"),
        ]);

        let err = ingest::detect_file_type(
            "unsafe.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            &bytes,
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("zip_entry_name_unsafe"));
    }

    #[test]
    fn rejects_pdf_with_too_many_pages() {
        let bytes = blank_pdf_with_pages(ingest::MAX_PDF_PAGES + 1);

        let err = ingest::parse_document(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "large.pdf",
            "application/pdf",
            &bytes,
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("pdf_page_count_exceeded"));
    }

    #[test]
    fn rejects_pdf_page_with_too_much_text() {
        let text = "A".repeat(ingest::MAX_PDF_PAGE_TEXT_CHARS + 1);
        let bytes = single_page_pdf_with_text(&text);

        let err = ingest::parse_document(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "dense.pdf",
            "application/pdf",
            &bytes,
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("pdf_page_text_chars_exceeded"));
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
    fn scanned_pdf_without_text_layer_is_low_confidence_not_failed() {
        let bytes = blank_pdf_with_pages(1);
        let artifacts = build_parse_artifacts(&pdf_task("scanned.pdf", bytes)).unwrap();

        assert_eq!(artifacts.parse_status, "parse_low_confidence");
        assert_eq!(artifacts.bundle.chunks.len(), 0);
        assert!(artifacts
            .bundle
            .parsed
            .warnings
            .iter()
            .any(|warning| warning == "scanned_pdf_no_text_layer"));
    }

    #[test]
    fn force_index_converts_low_confidence_with_chunks_to_chunked() {
        let mut task = test_task("short.txt", "短文本");
        task.force_index = true;
        let artifacts = build_parse_artifacts(&task).unwrap();

        assert_eq!(artifacts.parse_status, "chunked");
        assert_eq!(artifacts.bundle.chunks.len(), 1);
        assert_eq!(artifacts.parser_config["force_index"], json!(true));
    }

    #[test]
    fn force_index_rejects_scanned_pdf_without_chunks() {
        let mut task = pdf_task("scanned.pdf", blank_pdf_with_pages(1));
        task.force_index = true;
        let err = match build_parse_artifacts(&task) {
            Ok(_) => panic!("force_index should reject scanned PDF without chunks"),
            Err(err) => err,
        };
        let (code, message) = app_error_details(&err);

        assert_eq!(code, "FORCE_INDEX_UNAVAILABLE");
        assert!(message.contains("没有有效切片"));
    }

    #[test]
    fn exclude_from_search_only_allows_terminal_document_states() {
        for status in [
            "indexed",
            "parse_low_confidence",
            "parse_failed",
            "embedding_failed",
        ] {
            assert!(
                can_exclude_from_search(status),
                "{status} should be allowed"
            );
        }

        for status in ["uploaded", "parsing", "chunked", "embedding", "deleted"] {
            assert!(
                !can_exclude_from_search(status),
                "{status} should be rejected"
            );
        }
    }

    #[test]
    fn replace_file_only_allows_terminal_document_states() {
        for status in [
            "indexed",
            "parse_low_confidence",
            "parse_failed",
            "embedding_failed",
            "excluded_from_search",
        ] {
            assert!(can_replace_file(status), "{status} should be allowed");
        }

        for status in ["uploaded", "parsing", "chunked", "embedding", "deleted"] {
            assert!(!can_replace_file(status), "{status} should be rejected");
        }
    }

    #[test]
    fn send_to_ocr_only_allows_low_confidence_documents() {
        assert!(can_send_to_ocr("parse_low_confidence"));
        for status in [
            "indexed",
            "parse_failed",
            "embedding_failed",
            "ocr_pending",
            "uploaded",
            "parsing",
            "deleted",
        ] {
            assert!(!can_send_to_ocr(status), "{status} should be rejected");
        }
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

    #[test]
    fn interrupted_document_final_status_is_retryable_and_explainable() {
        assert_eq!(
            interrupted_document_final_status("embedding", "parse"),
            "embedding_failed"
        );
        assert_eq!(
            interrupted_document_final_status("ocr_pending", "ocr"),
            "parse_low_confidence"
        );
        assert_eq!(
            interrupted_document_final_status("parsing", "ocr"),
            "parse_low_confidence"
        );
        assert_eq!(
            interrupted_document_final_status("parsing", "parse"),
            "parse_failed"
        );
        assert_eq!(
            interrupted_document_final_status("uploaded", "parse"),
            "parse_failed"
        );
    }

    #[test]
    fn non_ocr_parse_metadata_does_not_clear_ocr_status() {
        let task = test_task("normal.txt", "普通解析任务");

        let running = parse_running_metadata(&task);
        let failed = parse_failed_metadata(&task, "PARSE_FAILED", "解析失败");

        assert!(running.get("ocr_status").is_none());
        assert!(failed.get("ocr_status").is_none());
        assert_eq!(
            running.get("parse_progress").and_then(Value::as_i64),
            Some(30)
        );
    }

    #[test]
    fn ocr_parse_metadata_sets_explicit_ocr_status() {
        let mut task = pdf_task("scan.pdf", b"%PDF-1.4\n%%EOF".to_vec());
        if let Some(config) = task.parser_config.as_object_mut() {
            config.insert("job_kind".to_string(), json!("ocr"));
        }

        let running = parse_running_metadata(&task);
        let failed = parse_failed_metadata(&task, "OCR_FAILED", "OCR failed");

        assert_eq!(
            running.get("ocr_status").and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            failed.get("ocr_status").and_then(Value::as_str),
            Some("failed")
        );
        assert_eq!(
            running.get("parse_progress").and_then(Value::as_i64),
            Some(45)
        );
    }

    fn test_task(file_name: &str, text: &str) -> ParseJobTask {
        let file_sha256 = sha256_hex(text.as_bytes());
        let parser_config = current_parser_config();
        let parse_identity = parse_identity_for(&file_sha256, &parser_config);
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
            parser_config,
            parse_identity,
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
            force_index: false,
        }
    }

    fn pdf_task(file_name: &str, bytes: Vec<u8>) -> ParseJobTask {
        let file_sha256 = sha256_hex(&bytes);
        let parser_config = current_parser_config();
        let parse_identity = parse_identity_for(&file_sha256, &parser_config);
        ParseJobTask {
            tenant_id: Uuid::new_v4(),
            kb_id: Uuid::new_v4(),
            doc_id: Uuid::new_v4(),
            parse_job_id: Uuid::new_v4(),
            parse_version: 1,
            title: title_from_file_name(file_name),
            file_name: file_name.to_string(),
            mime_type: "application/pdf".to_string(),
            file_type: "pdf".to_string(),
            parser_config,
            parse_identity,
            bytes,
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
            force_index: false,
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

    fn zip_with_many_entries(count: usize) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        writer
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"<w:document/>").unwrap();
        for index in 1..count {
            writer
                .start_file(
                    format!("docProps/empty-{index}.xml"),
                    SimpleFileOptions::default(),
                )
                .unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn blank_pdf_with_pages(page_count: usize) -> Vec<u8> {
        use lopdf::{dictionary, Document, Object};

        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let content_id = doc.add_object(lopdf::Stream::new(dictionary! {}, Vec::new()));
        let mut kids = Vec::with_capacity(page_count);
        for _ in 0..page_count {
            let page_id = doc.new_object_id();
            doc.objects.insert(
                page_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Page",
                    "Parent" => pages_id,
                    "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
                    "Resources" => dictionary! {},
                    "Contents" => content_id,
                }),
            );
            kids.push(Object::Reference(page_id));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(kids),
                "Count" => page_count as i64,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    fn single_page_pdf_with_text(text: &str) -> Vec<u8> {
        let escaped = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let stream = format!("BT\n/F1 12 Tf\n72 720 Td\n({escaped}) Tj\nET").into_bytes();
        let objects = vec![
            b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_vec(),
            b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n".to_vec(),
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n".to_vec(),
            b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".to_vec(),
            [
                format!("5 0 obj\n<< /Length {} >>\nstream\n", stream.len()).into_bytes(),
                stream,
                b"\nendstream\nendobj\n".to_vec(),
            ]
            .concat(),
        ];
        let mut data = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for object in objects {
            offsets.push(data.len());
            data.extend(object);
        }
        let xref_offset = data.len();
        data.extend(format!("xref\n0 {}\n", offsets.len() + 1).into_bytes());
        data.extend(b"0000000000 65535 f \n");
        for offset in offsets {
            data.extend(format!("{offset:010} 00000 n \n").into_bytes());
        }
        data.extend(
            format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n")
                .into_bytes(),
        );
        data
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
    let doc = fetch_document(pool, actor.tenant_id, doc_id).await?;
    download_pdf_page_from_document(&state, &doc, page).await
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
        root_pages.set("Kids", Object::Array(vec![Object::Reference(target_id)]));
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

fn pdf_page_count(pdf_bytes: &[u8]) -> anyhow::Result<u32> {
    let doc = lopdf::Document::load_mem(pdf_bytes)?;
    Ok(doc.get_pages().len() as u32)
}
