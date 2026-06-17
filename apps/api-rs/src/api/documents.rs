use axum::extract::{Multipart, Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::path::PathBuf;
use tracing::{error, info};
use uuid::Uuid;

use crate::auth::{require_permission, ActorExtractor};
use crate::document::{self, ParsedBundle, PARSER_VERSION, SCHEMA_VERSION};
use crate::error::AppError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/documents",
            get(list_documents).post(upload_document),
        )
        .route("/api/admin/documents/:doc_id", get(get_document))
        .route("/api/admin/documents/:doc_id/retry", post(retry_parse))
}

#[derive(Debug, Deserialize)]
struct DocumentListQuery {
    kb_id: Option<Uuid>,
    status: Option<String>,
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
    blocks: Vec<BlockSummary>,
    chunks: Vec<ChunkSummary>,
    tables: Vec<TableSummary>,
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

async fn list_documents(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Query(query): Query<DocumentListQuery>,
) -> Result<Json<Vec<DocumentSummary>>, AppError> {
    require_permission(&actor, "document.upload")?;
    let pool = db(&state)?;

    let rows = sqlx::query(
        r#"
        SELECT d.doc_id, d.kb_id, kb.name AS kb_name, d.title, d.file_name, d.file_type,
               d.mime_type, d.file_size, d.file_sha256, d.parse_status, d.parse_version,
               d.latest_parse_job_id, j.quality_score, d.chunk_count, d.table_count,
               d.page_count, d.uploaded_at, d.updated_at
        FROM documents d
        JOIN knowledge_base kb ON kb.id = d.kb_id
        LEFT JOIN document_parse_jobs j ON j.parse_job_id = d.latest_parse_job_id
        WHERE d.tenant_id = $1
          AND ($2::uuid IS NULL OR d.kb_id = $2)
          AND ($3::text IS NULL OR $3 = 'all' OR d.parse_status = $3)
        ORDER BY d.updated_at DESC
        LIMIT 200
        "#,
    )
    .bind(actor.tenant_id)
    .bind(query.kb_id)
    .bind(query.status)
    .fetch_all(pool)
    .await?;

    Ok(Json(
        rows.into_iter().map(document_summary_from_row).collect(),
    ))
}

async fn upload_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    mut multipart: Multipart,
) -> Result<Json<DocumentSummary>, AppError> {
    require_permission(&actor, "document.upload")?;
    let pool = db(&state)?.clone();

    let mut kb_id = actor.allowed_kb_ids.first().copied();
    let mut file_name = None;
    let mut mime_type = "application/octet-stream".to_string();
    let mut bytes = None;

    while let Some(field) = multipart.next_field().await? {
        match field.name().unwrap_or_default() {
            "kb_id" => {
                let value = field.text().await?;
                kb_id = Uuid::parse_str(value.trim()).ok();
            }
            "file" => {
                file_name = field.file_name().map(sanitize_file_name);
                mime_type = field
                    .content_type()
                    .map(str::to_string)
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                bytes = Some(field.bytes().await?.to_vec());
            }
            _ => {}
        }
    }

    let kb_id = kb_id.ok_or_else(|| AppError::bad_request("请选择知识库"))?;
    if !actor.allowed_kb_ids.contains(&kb_id) && !actor.has_permission("kb.manage") {
        return Err(AppError::kb_scope_denied());
    }
    let file_name = file_name.ok_or_else(|| AppError::bad_request("请选择文件"))?;
    let bytes = bytes.ok_or_else(|| AppError::bad_request("文件内容为空"))?;
    if bytes.is_empty() {
        return Err(AppError::bad_request("文件内容为空"));
    }
    let detected = document::detect_file_type(&file_name, &mime_type, &bytes)
        .map_err(|e| AppError::bad_request(format!("文件类型校验失败: {e}")))?;
    let doc_id = Uuid::new_v4();
    let parse_job_id = Uuid::new_v4();
    let file_sha256 = hex_sha256(&bytes);
    let title = title_from_file_name(&file_name);
    let ext = detected.as_str();
    let storage_key = format!(
        "tenants/{}/knowledge-bases/{}/documents/{}/original/{}.{}",
        actor.tenant_id, kb_id, doc_id, file_sha256, ext
    );

    write_blob(&state, &storage_key, &bytes).await?;

    sqlx::query(
        r#"
        INSERT INTO documents (
          doc_id, tenant_id, kb_id, title, file_name, file_type, mime_type,
          file_size, file_sha256, storage_key, parse_status, parse_version,
          uploaded_by, uploaded_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uploaded', 1, $11, now(), now())
        "#,
    )
    .bind(doc_id)
    .bind(actor.tenant_id)
    .bind(kb_id)
    .bind(&title)
    .bind(&file_name)
    .bind(detected.as_str())
    .bind(&mime_type)
    .bind(bytes.len() as i64)
    .bind(&file_sha256)
    .bind(&storage_key)
    .bind(actor.user_id)
    .execute(&pool)
    .await?;

    create_parse_job(&pool, parse_job_id, doc_id).await?;
    spawn_parse(
        state.clone(),
        pool.clone(),
        doc_id,
        kb_id,
        parse_job_id,
        file_name,
        mime_type,
        bytes,
    );

    let summary = fetch_document_summary(&pool, actor.tenant_id, doc_id).await?;
    Ok(Json(summary))
}

async fn get_document(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(doc_id): Path<Uuid>,
) -> Result<Json<DocumentDetail>, AppError> {
    require_permission(&actor, "document.upload")?;
    let pool = db(&state)?;
    let document = fetch_document_summary(pool, actor.tenant_id, doc_id).await?;
    let latest_job = if let Some(job_id) = document.latest_parse_job_id {
        fetch_parse_job(pool, job_id).await?
    } else {
        None
    };
    let blocks = fetch_blocks(pool, doc_id, document.latest_parse_job_id).await?;
    let chunks = fetch_chunks(pool, doc_id, document.latest_parse_job_id).await?;
    let tables = fetch_tables(pool, doc_id, document.latest_parse_job_id).await?;
    Ok(Json(DocumentDetail {
        document,
        latest_job,
        blocks,
        chunks,
        tables,
    }))
}

async fn retry_parse(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(doc_id): Path<Uuid>,
) -> Result<Json<DocumentSummary>, AppError> {
    require_permission(&actor, "document.reprocess")?;
    let pool = db(&state)?.clone();
    let row = sqlx::query(
        "SELECT doc_id, kb_id, file_name, mime_type, storage_key FROM documents WHERE tenant_id = $1 AND doc_id = $2",
    )
    .bind(actor.tenant_id)
    .bind(doc_id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound {
        code: "DOCUMENT_NOT_FOUND".to_string(),
        message: "文档不存在或无权限".to_string(),
    })?;

    let kb_id: Uuid = row.get("kb_id");
    let file_name: String = row.get("file_name");
    let mime_type: String = row.get("mime_type");
    let storage_key: String = row.get("storage_key");
    let bytes = read_blob(&state, &storage_key).await?;
    let parse_job_id = Uuid::new_v4();
    create_parse_job(&pool, parse_job_id, doc_id).await?;
    sqlx::query("UPDATE documents SET parse_status = 'uploaded', parse_version = parse_version + 1, updated_at = now() WHERE doc_id = $1")
        .bind(doc_id)
        .execute(&pool)
        .await?;
    spawn_parse(
        state.clone(),
        pool.clone(),
        doc_id,
        kb_id,
        parse_job_id,
        file_name,
        mime_type,
        bytes,
    );
    let summary = fetch_document_summary(&pool, actor.tenant_id, doc_id).await?;
    Ok(Json(summary))
}

fn spawn_parse(
    _state: AppState,
    pool: PgPool,
    doc_id: Uuid,
    kb_id: Uuid,
    parse_job_id: Uuid,
    file_name: String,
    mime_type: String,
    bytes: Vec<u8>,
) {
    tokio::spawn(async move {
        if let Err(err) = run_parse_job(
            &pool,
            doc_id,
            kb_id,
            parse_job_id,
            &file_name,
            &mime_type,
            &bytes,
        )
        .await
        {
            error!(%doc_id, %parse_job_id, error = %err, "document parse failed");
            let _ = mark_parse_failed(&pool, doc_id, parse_job_id, "parse_error", &err.to_string())
                .await;
        }
    });
}

async fn run_parse_job(
    pool: &PgPool,
    doc_id: Uuid,
    kb_id: Uuid,
    parse_job_id: Uuid,
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE document_parse_jobs SET status = 'parsing', started_at = now() WHERE parse_job_id = $1",
    )
    .bind(parse_job_id)
    .execute(pool)
    .await?;
    sqlx::query(
        "UPDATE documents SET parse_status = 'parsing', updated_at = now() WHERE doc_id = $1",
    )
    .bind(doc_id)
    .execute(pool)
    .await?;

    let bundle = document::parse_document(doc_id, parse_job_id, file_name, mime_type, bytes)?;
    persist_bundle(pool, doc_id, kb_id, parse_job_id, bundle).await?;
    info!(%doc_id, %parse_job_id, "document parse completed");
    Ok(())
}

async fn persist_bundle(
    pool: &PgPool,
    doc_id: Uuid,
    kb_id: Uuid,
    parse_job_id: Uuid,
    bundle: ParsedBundle,
) -> anyhow::Result<()> {
    let parsed = bundle.parsed;
    let char_count: i32 = parsed
        .blocks
        .iter()
        .map(|b| b.text.chars().count() as i32)
        .sum();
    let status = if parsed.quality_score < 0.55 {
        "parse_failed"
    } else if parsed.quality_score < 0.75 {
        "parse_low_confidence"
    } else {
        "parsed"
    };
    let job_status = if status == "parse_failed" {
        "failed"
    } else {
        "completed"
    };
    let warnings = serde_json::to_value(&parsed.warnings)?;
    let parsed_json = serde_json::to_value(&parsed)?;

    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO document_parse_results (parse_job_id, doc_id, parsed_json, schema_version)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (parse_job_id) DO UPDATE
        SET parsed_json = EXCLUDED.parsed_json,
            schema_version = EXCLUDED.schema_version
        "#,
    )
    .bind(parse_job_id)
    .bind(doc_id)
    .bind(parsed_json)
    .bind(SCHEMA_VERSION)
    .execute(&mut *tx)
    .await?;

    for block in &parsed.blocks {
        sqlx::query(
            r#"
            INSERT INTO document_blocks (
              block_id, doc_id, parse_job_id, block_index, block_type, text, normalized_text,
              heading_level, heading_path, page_start, page_end, slide_index, table_id, bbox,
              source_ref, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            "#,
        )
        .bind(block.block_id)
        .bind(doc_id)
        .bind(parse_job_id)
        .bind(block.block_index)
        .bind(&block.block_type)
        .bind(&block.text)
        .bind(block.text.trim())
        .bind(block.heading_level)
        .bind(&block.heading_path)
        .bind(block.page_start)
        .bind(block.page_end)
        .bind(block.slide_index)
        .bind(block.table_id)
        .bind(&block.bbox)
        .bind(&block.source_ref)
        .bind(&block.metadata)
        .execute(&mut *tx)
        .await?;
    }

    for table in &parsed.tables {
        let raw_json = serde_json::to_value(table)?;
        let row_count = table.rows.len() as i32 + i32::from(!table.headers.is_empty());
        let col_count = std::iter::once(table.headers.len())
            .chain(table.rows.iter().map(Vec::len))
            .max()
            .unwrap_or(0) as i32;
        sqlx::query(
            r#"
            INSERT INTO document_tables (
              table_id, doc_id, parse_job_id, block_id, table_index, title, heading_path,
              page_start, page_end, slide_index, row_count, col_count, headers, raw_json,
              markdown, quality, source_ref
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            "#,
        )
        .bind(table.table_id)
        .bind(doc_id)
        .bind(parse_job_id)
        .bind(table.block_id)
        .bind(table.table_index)
        .bind(&table.title)
        .bind(&table.heading_path)
        .bind(table.page_start)
        .bind(table.page_end)
        .bind(table.slide_index)
        .bind(row_count)
        .bind(col_count)
        .bind(serde_json::to_value(&table.headers)?)
        .bind(raw_json)
        .bind(&table.markdown)
        .bind(&table.quality)
        .bind(&table.source_ref)
        .execute(&mut *tx)
        .await?;

        for cell in &table.cells {
            sqlx::query(
                r#"
                INSERT INTO document_table_cells (
                  cell_id, table_id, row_index, col_index, rowspan, colspan, text,
                  normalized_text, is_header, data_type, bbox, style, source_ref
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                "#,
            )
            .bind(cell.cell_id)
            .bind(table.table_id)
            .bind(cell.row_index)
            .bind(cell.col_index)
            .bind(cell.rowspan)
            .bind(cell.colspan)
            .bind(&cell.text)
            .bind(&cell.normalized_text)
            .bind(cell.is_header)
            .bind(&cell.data_type)
            .bind(&cell.bbox)
            .bind(&cell.style)
            .bind(&cell.source_ref)
            .execute(&mut *tx)
            .await?;
        }
    }

    for chunk in &bundle.chunks {
        sqlx::query(
            r#"
            INSERT INTO chunks (
              chunk_id, doc_id, kb_id, parse_job_id, chunk_index, source_type, content,
              heading_path, page_start, page_end, slide_start, slide_end, token_count,
              block_ids, metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            "#,
        )
        .bind(chunk.chunk_id)
        .bind(doc_id)
        .bind(kb_id)
        .bind(parse_job_id)
        .bind(chunk.chunk_index)
        .bind(&chunk.source_type)
        .bind(&chunk.content)
        .bind(&chunk.heading_path)
        .bind(chunk.page_start)
        .bind(chunk.page_end)
        .bind(chunk.slide_start)
        .bind(chunk.slide_end)
        .bind(chunk.token_count)
        .bind(&chunk.block_ids)
        .bind(&chunk.metadata)
        .execute(&mut *tx)
        .await?;
        for table_id in &chunk.table_ids {
            sqlx::query("INSERT INTO chunk_tables (chunk_id, table_id) VALUES ($1, $2)")
                .bind(chunk.chunk_id)
                .bind(table_id)
                .execute(&mut *tx)
                .await?;
        }
    }

    sqlx::query(
        r#"
        UPDATE document_parse_jobs
        SET status = $2, quality_score = $3, page_count = $4, block_count = $5,
            table_count = $6, char_count = $7, warnings = $8, finished_at = now()
        WHERE parse_job_id = $1
        "#,
    )
    .bind(parse_job_id)
    .bind(job_status)
    .bind(parsed.quality_score)
    .bind(parsed.pages)
    .bind(parsed.blocks.len() as i32)
    .bind(parsed.tables.len() as i32)
    .bind(char_count)
    .bind(warnings)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        UPDATE documents
        SET parse_status = $2, latest_parse_job_id = $3, chunk_count = $4,
            table_count = $5, page_count = $6, updated_at = now()
        WHERE doc_id = $1
        "#,
    )
    .bind(doc_id)
    .bind(status)
    .bind(parse_job_id)
    .bind(bundle.chunks.len() as i32)
    .bind(parsed.tables.len() as i32)
    .bind(parsed.pages)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

async fn mark_parse_failed(
    pool: &PgPool,
    doc_id: Uuid,
    parse_job_id: Uuid,
    code: &str,
    message: &str,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE document_parse_jobs SET status = 'failed', error_code = $2, error_message = $3, finished_at = now() WHERE parse_job_id = $1",
    )
    .bind(parse_job_id)
    .bind(code)
    .bind(message)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE documents SET parse_status = 'parse_failed', latest_parse_job_id = $2, updated_at = now() WHERE doc_id = $1",
    )
    .bind(doc_id)
    .bind(parse_job_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn create_parse_job(pool: &PgPool, parse_job_id: Uuid, doc_id: Uuid) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO document_parse_jobs (parse_job_id, doc_id, parser_version, parser_config, status)
        VALUES ($1, $2, $3, '{}', 'queued')
        "#,
    )
    .bind(parse_job_id)
    .bind(doc_id)
    .bind(PARSER_VERSION)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE documents SET latest_parse_job_id = $2, updated_at = now() WHERE doc_id = $1",
    )
    .bind(doc_id)
    .bind(parse_job_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn fetch_document_summary(
    pool: &PgPool,
    tenant_id: Uuid,
    doc_id: Uuid,
) -> Result<DocumentSummary, AppError> {
    let row = sqlx::query(
        r#"
        SELECT d.doc_id, d.kb_id, kb.name AS kb_name, d.title, d.file_name, d.file_type,
               d.mime_type, d.file_size, d.file_sha256, d.parse_status, d.parse_version,
               d.latest_parse_job_id, j.quality_score, d.chunk_count, d.table_count,
               d.page_count, d.uploaded_at, d.updated_at
        FROM documents d
        JOIN knowledge_base kb ON kb.id = d.kb_id
        LEFT JOIN document_parse_jobs j ON j.parse_job_id = d.latest_parse_job_id
        WHERE d.tenant_id = $1 AND d.doc_id = $2
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
    pool: &PgPool,
    parse_job_id: Uuid,
) -> Result<Option<ParseJobSummary>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT parse_job_id, status, parser_version, quality_score, page_count, block_count,
               table_count, char_count, warnings, error_code, error_message, started_at,
               finished_at, created_at
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
    pool: &PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
) -> Result<Vec<BlockSummary>, AppError> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(vec![]);
    };
    let rows = sqlx::query(
        r#"
        SELECT block_id, block_index, block_type, text, heading_level, heading_path,
               page_start, page_end, slide_index, table_id
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
        .map(|row| BlockSummary {
            block_id: row.get("block_id"),
            block_index: row.get("block_index"),
            block_type: row.get("block_type"),
            text: row.get("text"),
            heading_level: row.get("heading_level"),
            heading_path: row.get("heading_path"),
            page_start: row.get("page_start"),
            page_end: row.get("page_end"),
            slide_index: row.get("slide_index"),
            table_id: row.get("table_id"),
        })
        .collect())
}

async fn fetch_chunks(
    pool: &PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
) -> Result<Vec<ChunkSummary>, AppError> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(vec![]);
    };
    let rows = sqlx::query(
        r#"
        SELECT chunk_id, chunk_index, source_type, content, heading_path,
               page_start, page_end, slide_start, slide_end, token_count
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
        .map(|row| ChunkSummary {
            chunk_id: row.get("chunk_id"),
            chunk_index: row.get("chunk_index"),
            source_type: row.get("source_type"),
            content: row.get("content"),
            heading_path: row.get("heading_path"),
            page_start: row.get("page_start"),
            page_end: row.get("page_end"),
            slide_start: row.get("slide_start"),
            slide_end: row.get("slide_end"),
            token_count: row.get("token_count"),
        })
        .collect())
}

async fn fetch_tables(
    pool: &PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
) -> Result<Vec<TableSummary>, AppError> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(vec![]);
    };
    let rows = sqlx::query(
        r#"
        SELECT table_id, table_index, title, row_count, col_count, headers, markdown, quality
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
        .map(|row| TableSummary {
            table_id: row.get("table_id"),
            table_index: row.get("table_index"),
            title: row.get("title"),
            row_count: row.get("row_count"),
            col_count: row.get("col_count"),
            headers: row.get("headers"),
            markdown: row.get("markdown"),
            quality: row.get("quality"),
        })
        .collect())
}

fn db(state: &AppState) -> Result<&PgPool, AppError> {
    state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("文档解析需要启用 PostgreSQL"))
}

async fn write_blob(state: &AppState, storage_key: &str, bytes: &[u8]) -> Result<(), AppError> {
    let path = blob_path(state, storage_key);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, bytes).await?;
    Ok(())
}

async fn read_blob(state: &AppState, storage_key: &str) -> Result<Vec<u8>, AppError> {
    Ok(tokio::fs::read(blob_path(state, storage_key)).await?)
}

fn blob_path(state: &AppState, storage_key: &str) -> PathBuf {
    PathBuf::from(&state.config.blob_storage_dir).join(storage_key)
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

fn title_from_file_name(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(file_name)
        .trim()
        .to_string()
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}
