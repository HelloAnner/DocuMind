use std::collections::HashMap;

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::config::EmbeddingConfig;
use crate::models::source_anchor::{CharRange, NormalizedBBox};
use crate::rag::embedding::EmbeddingClient;
use crate::rag::vector_index::{ElasticsearchChunkIndexer, EsRange, IndexedChunk};
use crate::rag::vector_jobs;
use crate::rag::vector_store::{
    mark_batch_failed, mark_batch_running, mark_document_embedding, mark_document_indexed,
    save_embedding, EmbeddingBatchItem, EmbeddingScope,
};

#[derive(Debug, Clone)]
struct DocumentScope {
    tenant_id: Uuid,
    kb_id: Uuid,
    title: String,
    file_type: String,
    latest_parse_job_id: Option<Uuid>,
    parse_status: String,
}

#[derive(Debug, Clone)]
struct StoredChunk {
    chunk_id: Uuid,
    chunk_index: i32,
    source_type: String,
    content: String,
    heading_path: Vec<String>,
    page_range: Vec<i32>,
    token_count: i32,
    block_ids: Vec<Uuid>,
    table_ids: Vec<Uuid>,
    anchor_ids: Vec<Uuid>,
    primary_anchor_id: Option<Uuid>,
    anchor_quality: String,
    metadata: Value,
    created_at: DateTime<Utc>,
    anchor_format: Option<String>,
    anchor_kind: Option<String>,
    anchor_page: Option<i32>,
    anchor_slide: Option<i32>,
    anchor_char_range: Option<CharRange>,
    anchor_bbox: Option<NormalizedBBox>,
    anchor_text: Option<String>,
}

#[derive(Debug, Clone)]
struct StoredEmbedding {
    vector: Vec<f64>,
    content_hash: String,
    embedded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
struct StoredEmbeddings {
    by_chunk: HashMap<Uuid, StoredEmbedding>,
    by_hash: HashMap<String, StoredEmbedding>,
}

#[derive(Debug, Clone, Default)]
pub struct IndexDocumentOutcome {
    pub indexed_chunks: usize,
    pub generated_embeddings: usize,
    pub reused_embeddings: usize,
    pub skipped: bool,
}

pub async fn index_document(
    pool: &PgPool,
    embedding_client: &EmbeddingClient,
    indexer: &ElasticsearchChunkIndexer,
    doc_id: Uuid,
    parse_job_id: Uuid,
    config: &EmbeddingConfig,
) -> Result<IndexDocumentOutcome> {
    let document = load_document(pool, doc_id).await?;
    if document.latest_parse_job_id != Some(parse_job_id)
        || document.parse_status == "excluded_from_search"
    {
        return Ok(IndexDocumentOutcome {
            skipped: true,
            ..IndexDocumentOutcome::default()
        });
    }

    let chunks = load_chunks(pool, doc_id, parse_job_id).await?;
    if chunks.is_empty() {
        bail!("document {doc_id} parse {parse_job_id} has no chunks to index");
    }
    let scope = EmbeddingScope {
        tenant_id: document.tenant_id,
        kb_id: document.kb_id,
        doc_id,
        parse_job_id,
    };
    mark_document_embedding(pool, scope, config).await?;

    let existing = load_embeddings(pool, doc_id, &config.model, config.dimension).await?;
    let mut vectors = HashMap::<Uuid, StoredEmbedding>::new();
    let mut missing = Vec::new();
    let mut reused_copies = Vec::new();
    for chunk in &chunks {
        let input = embedding_input(&document.title, chunk);
        let hash = sha256_hex(input.as_bytes());
        match existing.by_chunk.get(&chunk.chunk_id) {
            Some(embedding) if embedding.content_hash == hash => {
                vectors.insert(chunk.chunk_id, embedding.clone());
            }
            _ => match existing.by_hash.get(&hash) {
                Some(embedding) => {
                    vectors.insert(chunk.chunk_id, embedding.clone());
                    reused_copies.push((chunk.chunk_id, hash, embedding.clone()));
                }
                None => missing.push((chunk, input, hash)),
            },
        }
    }

    if !reused_copies.is_empty() {
        let items = reused_copies
            .iter()
            .map(|(chunk_id, hash, _)| EmbeddingBatchItem {
                chunk_id: *chunk_id,
                content_hash: hash.clone(),
            })
            .collect::<Vec<_>>();
        mark_batch_running(pool, scope, &config.model, config.dimension, &items).await?;
        for (item, (_, _, embedding)) in items.iter().zip(&reused_copies) {
            save_embedding(
                pool,
                scope,
                &config.model,
                item,
                &embedding.vector,
                embedding.embedded_at,
            )
            .await?;
        }
    }

    let mut generated = 0usize;
    for batch in missing.chunks(embedding_client.batch_size()) {
        let batch_items = batch
            .iter()
            .map(|(chunk, _, hash)| EmbeddingBatchItem {
                chunk_id: chunk.chunk_id,
                content_hash: hash.clone(),
            })
            .collect::<Vec<_>>();
        mark_batch_running(pool, scope, &config.model, config.dimension, &batch_items).await?;
        let inputs = batch
            .iter()
            .map(|(_, input, _)| input.clone())
            .collect::<Vec<_>>();
        let generated_vectors = match embedding_client.embed_batch(&inputs).await {
            Ok(vectors) => vectors,
            Err(error) => {
                mark_batch_failed(pool, &config.model, &batch_items, &error.to_string()).await?;
                return Err(error);
            }
        };
        if generated_vectors.len() != batch.len() {
            bail!(
                "embedding provider returned {} vectors for {} chunks",
                generated_vectors.len(),
                batch.len()
            );
        }
        let now = Utc::now();
        for (((chunk, _, hash), item), vector) in
            batch.iter().zip(batch_items.iter()).zip(generated_vectors)
        {
            validate_vector(&vector, config.dimension)?;
            save_embedding(pool, scope, &config.model, item, &vector, now).await?;
            vectors.insert(
                chunk.chunk_id,
                StoredEmbedding {
                    vector,
                    content_hash: hash.clone(),
                    embedded_at: now,
                },
            );
            generated += 1;
        }
    }

    let indexed_chunks = chunks
        .iter()
        .map(|chunk| {
            let embedding = vectors
                .get(&chunk.chunk_id)
                .ok_or_else(|| anyhow!("chunk {} is missing an embedding", chunk.chunk_id))?;
            Ok(to_indexed_chunk(
                &document,
                doc_id,
                parse_job_id,
                chunk,
                embedding,
                config,
            ))
        })
        .collect::<Result<Vec<_>>>()?;

    indexer.ensure_index(config.dimension).await?;
    indexer.delete_document_chunks(doc_id).await?;
    for batch in indexed_chunks.chunks(500) {
        indexer.bulk_index(batch).await?;
    }
    indexer.refresh().await?;
    let actual = indexer.count_document_parse(doc_id, parse_job_id).await? as usize;
    if actual != indexed_chunks.len() {
        bail!(
            "elasticsearch indexed {actual} chunks for document {doc_id}, expected {}",
            indexed_chunks.len()
        );
    }
    if !mark_document_indexed(pool, scope, config, indexer.index_name(), actual).await? {
        indexer.delete_document_chunks(doc_id).await?;
        vector_jobs::refresh_active_version_counts(
            pool,
            indexer.index_name(),
            indexer.count().await? as i64,
        )
        .await?;
        return Ok(IndexDocumentOutcome {
            skipped: true,
            ..IndexDocumentOutcome::default()
        });
    }
    vector_jobs::refresh_active_version_counts(
        pool,
        indexer.index_name(),
        indexer.count().await? as i64,
    )
    .await?;

    Ok(IndexDocumentOutcome {
        indexed_chunks: actual,
        generated_embeddings: generated,
        reused_embeddings: indexed_chunks.len().saturating_sub(generated),
        skipped: false,
    })
}

async fn load_document(pool: &PgPool, doc_id: Uuid) -> Result<DocumentScope> {
    let row = sqlx::query(
        "SELECT tenant_id, kb_id, title, file_type, latest_parse_job_id, parse_status
         FROM documents WHERE id = $1",
    )
    .bind(doc_id)
    .fetch_one(pool)
    .await
    .context("failed to load document for vector indexing")?;
    Ok(DocumentScope {
        tenant_id: row.try_get("tenant_id")?,
        kb_id: row.try_get("kb_id")?,
        title: row.try_get("title")?,
        file_type: row.try_get("file_type")?,
        latest_parse_job_id: row.try_get("latest_parse_job_id")?,
        parse_status: row.try_get("parse_status")?,
    })
}

async fn load_chunks(pool: &PgPool, doc_id: Uuid, parse_job_id: Uuid) -> Result<Vec<StoredChunk>> {
    let rows = sqlx::query(
        "SELECT c.id, c.chunk_index, c.source_type, c.content, c.heading_path,
                c.page_range, c.token_count, c.block_ids, c.table_ids, c.anchor_ids,
                c.primary_anchor_id, c.anchor_quality, c.metadata, c.created_at,
                a.format, a.kind, a.page, a.slide, a.char_range, a.bbox, a.text AS anchor_text
         FROM chunks c
         LEFT JOIN document_source_anchors a ON a.id = c.primary_anchor_id
         WHERE c.doc_id = $1 AND c.parse_job_id = $2
         ORDER BY c.chunk_index",
    )
    .bind(doc_id)
    .bind(parse_job_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(StoredChunk {
                chunk_id: row.try_get("id")?,
                chunk_index: row.try_get("chunk_index")?,
                source_type: row.try_get("source_type")?,
                content: row.try_get("content")?,
                heading_path: row.try_get("heading_path")?,
                page_range: row.try_get("page_range")?,
                token_count: row.try_get("token_count")?,
                block_ids: row.try_get("block_ids")?,
                table_ids: row.try_get("table_ids")?,
                anchor_ids: row.try_get("anchor_ids")?,
                primary_anchor_id: row.try_get("primary_anchor_id")?,
                anchor_quality: row.try_get("anchor_quality")?,
                metadata: row.try_get("metadata")?,
                created_at: row.try_get("created_at")?,
                anchor_format: row.try_get("format")?,
                anchor_kind: row.try_get("kind")?,
                anchor_page: row.try_get("page")?,
                anchor_slide: row.try_get("slide")?,
                anchor_char_range: json_column(&row, "char_range"),
                anchor_bbox: json_column(&row, "bbox"),
                anchor_text: row.try_get("anchor_text")?,
            })
        })
        .collect()
}

async fn load_embeddings(
    pool: &PgPool,
    doc_id: Uuid,
    model: &str,
    dimension: usize,
) -> Result<StoredEmbeddings> {
    let rows = sqlx::query(
        "SELECT e.chunk_id, e.embedding_values, e.content_hash, e.embedded_at
         FROM chunk_embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         WHERE c.doc_id = $1 AND e.embedding_model = $2
           AND e.status = 'completed' AND e.embedding_dim = $3
           AND e.embedding_values IS NOT NULL",
    )
    .bind(doc_id)
    .bind(model)
    .bind(dimension as i32)
    .fetch_all(pool)
    .await?;
    let mut embeddings = StoredEmbeddings::default();
    for row in rows {
        let values: Vec<f32> = row.try_get("embedding_values")?;
        if values.len() != dimension || values.iter().any(|value| !value.is_finite()) {
            continue;
        }
        let embedding = StoredEmbedding {
            vector: values.into_iter().map(f64::from).collect(),
            content_hash: row.try_get("content_hash")?,
            embedded_at: row
                .try_get::<Option<chrono::DateTime<Utc>>, _>("embedded_at")?
                .unwrap_or_else(Utc::now),
        };
        embeddings
            .by_hash
            .entry(embedding.content_hash.clone())
            .or_insert_with(|| embedding.clone());
        embeddings
            .by_chunk
            .insert(row.try_get("chunk_id")?, embedding);
    }
    Ok(embeddings)
}

fn embedding_input(title: &str, chunk: &StoredChunk) -> String {
    let mut content = chunk.content.as_str();
    if content.starts_with("【上文】") {
        if let Some((_, current)) = content.split_once("\n\n") {
            content = current;
        }
    }
    if let Some((current, _)) = content.split_once("\n\n【下文】") {
        content = current;
    }
    let body = content
        .lines()
        .filter(|line| {
            !line.starts_with("标题路径：")
                && !line.starts_with("页码：")
                && !line.starts_with("Slide：")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut parts = vec![format!("文档：{title}")];
    if !chunk.heading_path.is_empty() {
        parts.push(format!("章节：{}", chunk.heading_path.join(" / ")));
    }
    parts.push(body.trim().to_string());
    parts.join("\n")
}

fn to_indexed_chunk(
    document: &DocumentScope,
    doc_id: Uuid,
    parse_job_id: Uuid,
    chunk: &StoredChunk,
    embedding: &StoredEmbedding,
    config: &EmbeddingConfig,
) -> IndexedChunk {
    IndexedChunk {
        chunk_id: chunk.chunk_id,
        doc_id,
        doc_title: document.title.clone(),
        file_type: document.file_type.clone(),
        kb_id: document.kb_id,
        tenant_id: document.tenant_id,
        parse_job_id,
        chunk_index: chunk.chunk_index,
        source_type: chunk.source_type.clone(),
        content: chunk.content.clone(),
        heading_path: chunk.heading_path.clone(),
        heading_text: chunk.heading_path.join(" / "),
        page_range: es_range(&chunk.page_range),
        slide_start: metadata_i32(&chunk.metadata, "slide_start"),
        slide_end: metadata_i32(&chunk.metadata, "slide_end"),
        token_count: chunk.token_count,
        block_ids: chunk.block_ids.clone(),
        table_ids: chunk.table_ids.clone(),
        anchor_ids: chunk.anchor_ids.clone(),
        primary_anchor_id: chunk.primary_anchor_id,
        anchor_quality: chunk.anchor_quality.clone(),
        anchor_format: chunk
            .anchor_format
            .clone()
            .unwrap_or_else(|| document.file_type.clone()),
        anchor_kind: chunk
            .anchor_kind
            .clone()
            .unwrap_or_else(|| chunk.source_type.clone()),
        anchor_page: chunk.anchor_page,
        anchor_slide: chunk.anchor_slide,
        anchor_char_range: chunk.anchor_char_range.clone(),
        anchor_bbox: chunk.anchor_bbox.clone(),
        anchor_text: chunk.anchor_text.clone().unwrap_or_default(),
        embedding_model: config.model.clone(),
        embedding: embedding.vector.clone(),
        metadata: chunk.metadata.clone(),
        created_at: chunk.created_at,
        embedded_at: embedding.embedded_at,
    }
}

fn es_range(pages: &[i32]) -> Option<EsRange> {
    Some(EsRange {
        gte: *pages.iter().min()?,
        lte: *pages.iter().max()?,
    })
}

fn metadata_i32(metadata: &Value, key: &str) -> Option<i32> {
    metadata
        .get(key)
        .and_then(Value::as_i64)
        .or_else(|| metadata.get("chunk_metadata")?.get(key)?.as_i64())
        .map(|value| value as i32)
}

fn json_column<T: serde::de::DeserializeOwned>(
    row: &sqlx::postgres::PgRow,
    name: &str,
) -> Option<T> {
    row.try_get::<Option<Value>, _>(name)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn validate_vector(vector: &[f64], dimension: usize) -> Result<()> {
    if vector.len() != dimension {
        bail!(
            "embedding dimension {} does not match configured {dimension}",
            vector.len()
        );
    }
    if vector.iter().any(|value| !value.is_finite()) {
        bail!("embedding contains a non-finite value");
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
