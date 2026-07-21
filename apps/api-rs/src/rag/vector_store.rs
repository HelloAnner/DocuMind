use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;
use tracing::info;
use uuid::Uuid;

use crate::config::EmbeddingConfig;

#[derive(Debug, Clone, Copy)]
pub struct EmbeddingScope {
    pub tenant_id: Uuid,
    pub kb_id: Uuid,
    pub doc_id: Uuid,
    pub parse_job_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct EmbeddingBatchItem {
    pub chunk_id: Uuid,
    pub content_hash: String,
}

pub async fn reconcile_legacy_embeddings(pool: &PgPool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let converted = sqlx::query(
        "WITH legacy_vectors AS (
            SELECT source.id,
                   array_agg(
                       CASE
                           WHEN jsonb_typeof(item.value) = 'number'
                           THEN (item.value #>> '{}')::REAL
                       END
                       ORDER BY item.ordinality
                   ) AS embedding_values,
                   bool_and(jsonb_typeof(item.value) = 'number') AS all_numeric
            FROM chunk_embeddings source
            CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(source.embedding_vector) = 'array'
                    THEN source.embedding_vector
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY AS item(value, ordinality)
            WHERE source.embedding_values IS NULL
              AND source.embedding_vector <> '[]'::jsonb
            GROUP BY source.id
         )
         UPDATE chunk_embeddings target
         SET embedding_values = legacy.embedding_values
         FROM legacy_vectors legacy
         WHERE target.id = legacy.id
           AND legacy.all_numeric
           AND cardinality(legacy.embedding_values) = target.embedding_dim",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let failed = sqlx::query(
        "UPDATE chunk_embeddings
         SET status = 'failed',
             index_status = 'failed',
             error_message = COALESCE(error_message, 'legacy embedding payload is invalid')
         WHERE embedding_values IS NULL
           AND embedding_vector <> '[]'::jsonb",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let compacted = sqlx::query(
        "UPDATE chunk_embeddings
         SET embedding_vector = '[]'::jsonb
         WHERE embedding_vector <> '[]'::jsonb",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    if converted > 0 || failed > 0 || compacted > 0 {
        info!(
            converted,
            failed, compacted, "reconciled legacy embedding storage"
        );
    }
    Ok(())
}

pub async fn mark_document_embedding(
    pool: &PgPool,
    scope: EmbeddingScope,
    config: &EmbeddingConfig,
) -> Result<()> {
    sqlx::query(
        "UPDATE documents
         SET parse_status = 'embedding',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE tenant_id = $2 AND id = $3 AND latest_parse_job_id = $4
           AND parse_status <> 'excluded_from_search'",
    )
    .bind(json!({
        "active_parse_job_id": scope.parse_job_id,
        "parse_progress": 85,
        "embedding_model": config.model,
        "embedding_dimension": config.dimension,
    }))
    .bind(scope.tenant_id)
    .bind(scope.doc_id)
    .bind(scope.parse_job_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_batch_running(
    pool: &PgPool,
    scope: EmbeddingScope,
    model: &str,
    dimension: usize,
    items: &[EmbeddingBatchItem],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    for item in items {
        sqlx::query(
            "INSERT INTO chunk_embeddings (
                tenant_id, kb_id, doc_id, chunk_id, embedding_model, embedding_dim,
                embedding_vector, embedding_values, content_hash, status,
                index_status, error_message
             )
             VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, NULL, $7,
                     'running', 'pending', NULL)
             ON CONFLICT (chunk_id, embedding_model) DO UPDATE
             SET embedding_dim = EXCLUDED.embedding_dim,
                 embedding_vector = '[]'::jsonb,
                 embedding_values = NULL,
                 content_hash = EXCLUDED.content_hash,
                 status = 'running',
                 index_status = 'pending',
                 index_name = NULL,
                 error_message = NULL,
                 embedded_at = NULL,
                 indexed_at = NULL",
        )
        .bind(scope.tenant_id)
        .bind(scope.kb_id)
        .bind(scope.doc_id)
        .bind(item.chunk_id)
        .bind(model)
        .bind(dimension as i32)
        .bind(&item.content_hash)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn mark_batch_failed(
    pool: &PgPool,
    model: &str,
    items: &[EmbeddingBatchItem],
    error: &str,
) -> Result<()> {
    let ids = items.iter().map(|item| item.chunk_id).collect::<Vec<_>>();
    sqlx::query(
        "UPDATE chunk_embeddings
         SET status = 'failed', error_message = $1
         WHERE embedding_model = $2 AND chunk_id = ANY($3)",
    )
    .bind(error)
    .bind(model)
    .bind(ids)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn save_embedding(
    pool: &PgPool,
    scope: EmbeddingScope,
    model: &str,
    item: &EmbeddingBatchItem,
    vector: &[f64],
    embedded_at: DateTime<Utc>,
) -> Result<()> {
    let values = vector.iter().map(|value| *value as f32).collect::<Vec<_>>();
    sqlx::query(
        "UPDATE chunk_embeddings
         SET embedding_values = $1,
             status = 'completed',
             index_status = 'pending',
             error_message = NULL,
             embedded_at = $2
         WHERE tenant_id = $3 AND kb_id = $4 AND doc_id = $5
           AND chunk_id = $6 AND embedding_model = $7",
    )
    .bind(values)
    .bind(embedded_at)
    .bind(scope.tenant_id)
    .bind(scope.kb_id)
    .bind(scope.doc_id)
    .bind(item.chunk_id)
    .bind(model)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_document_indexed(
    pool: &PgPool,
    scope: EmbeddingScope,
    config: &EmbeddingConfig,
    physical_index: &str,
    indexed_chunks: usize,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE documents
         SET parse_status = 'indexed',
             chunk_count = $1,
             metadata = metadata || $2,
             updated_at = NOW()
         WHERE tenant_id = $3 AND id = $4 AND latest_parse_job_id = $5
           AND parse_status <> 'excluded_from_search'",
    )
    .bind(indexed_chunks as i32)
    .bind(json!({
        "active_parse_job_id": scope.parse_job_id,
        "parse_progress": 100,
        "embedding_model": config.model,
        "embedding_dimension": config.dimension,
        "vector_index": physical_index,
        "indexed_chunks": indexed_chunks,
    }))
    .bind(scope.tenant_id)
    .bind(scope.doc_id)
    .bind(scope.parse_job_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 1 {
        sqlx::query(
            "UPDATE chunk_embeddings e
             SET index_status = 'indexed', index_name = $1, indexed_at = NOW(), error_message = NULL
             FROM chunks c
             WHERE e.chunk_id = c.id
               AND c.parse_job_id = $2
               AND e.embedding_model = $3
               AND e.status = 'completed'",
        )
        .bind(physical_index)
        .bind(scope.parse_job_id)
        .bind(&config.model)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(updated.rows_affected() == 1)
}

pub async fn mark_document_terminal_failure(
    pool: &PgPool,
    doc_id: Uuid,
    parse_job_id: Option<Uuid>,
    embedding_model: &str,
    error: &str,
) -> Result<()> {
    let Some(parse_job_id) = parse_job_id else {
        return Ok(());
    };
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE chunk_embeddings e
         SET index_status = 'failed', error_message = $1
         FROM chunks c
         WHERE e.chunk_id = c.id AND c.doc_id = $2 AND c.parse_job_id = $3
           AND e.embedding_model = $4",
    )
    .bind(error)
    .bind(doc_id)
    .bind(parse_job_id)
    .bind(embedding_model)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE documents
         SET parse_status = 'embedding_failed',
             metadata = metadata || $1,
             updated_at = NOW()
         WHERE id = $2 AND latest_parse_job_id = $3
           AND parse_status <> 'excluded_from_search'",
    )
    .bind(json!({
        "parse_progress": 100,
        "error_code": "VECTOR_JOB_FAILED",
        "error_message": error,
    }))
    .bind(doc_id)
    .bind(parse_job_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
