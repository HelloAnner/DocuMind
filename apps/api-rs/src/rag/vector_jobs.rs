use anyhow::{Context, Result};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::config::EmbeddingConfig;

#[derive(Debug, Clone)]
pub struct VectorJob {
    pub id: Uuid,
    pub operation: String,
    pub tenant_id: Option<Uuid>,
    pub kb_id: Option<Uuid>,
    pub doc_id: Option<Uuid>,
    pub parse_job_id: Option<Uuid>,
    pub embedding_model: String,
    pub embedding_dim: usize,
    pub target_index: String,
    pub attempt_count: i32,
    pub max_attempts: i32,
}

pub async fn enqueue_document(
    pool: &PgPool,
    tenant_id: Uuid,
    kb_id: Uuid,
    doc_id: Uuid,
    parse_job_id: Uuid,
    target_index: &str,
    config: &EmbeddingConfig,
    force: bool,
) -> Result<Uuid> {
    let dedupe_key = format!("index:{parse_job_id}:{}", config.model);
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO vector_jobs (
            dedupe_key, operation, tenant_id, kb_id, doc_id, parse_job_id,
            embedding_model, embedding_dim, target_index, max_attempts
         )
         VALUES ($1, 'index_document', $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (dedupe_key) DO UPDATE
         SET target_index = EXCLUDED.target_index,
             max_attempts = EXCLUDED.max_attempts,
             status = CASE
                 WHEN vector_jobs.status IN ('running', 'pending') THEN vector_jobs.status
                 WHEN $10 THEN 'pending'
                 ELSE vector_jobs.status
             END,
             attempt_count = CASE WHEN $10 THEN 0 ELSE vector_jobs.attempt_count END,
             available_at = CASE WHEN $10 THEN NOW() ELSE vector_jobs.available_at END,
             error_message = CASE WHEN $10 THEN NULL ELSE vector_jobs.error_message END,
             published_at = CASE WHEN $10 THEN NULL ELSE vector_jobs.published_at END,
             completed_at = CASE WHEN $10 THEN NULL ELSE vector_jobs.completed_at END,
             updated_at = NOW()
         RETURNING id",
    )
    .bind(dedupe_key)
    .bind(tenant_id)
    .bind(kb_id)
    .bind(doc_id)
    .bind(parse_job_id)
    .bind(&config.model)
    .bind(config.dimension as i32)
    .bind(target_index)
    .bind(config.retry_max.max(1))
    .bind(force)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn enqueue_rebuild(
    pool: &PgPool,
    target_index: &str,
    config: &EmbeddingConfig,
) -> Result<Uuid> {
    let dedupe_key = format!("rebuild:{target_index}");
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO vector_jobs (
            dedupe_key, operation, embedding_model, embedding_dim,
            target_index, max_attempts
         )
         VALUES ($1, 'rebuild_index', $2, $3, $4, $5)
         ON CONFLICT (dedupe_key) DO UPDATE
         SET status = CASE
                 WHEN vector_jobs.status IN ('running', 'pending') THEN vector_jobs.status
                 ELSE 'pending'
             END,
             attempt_count = CASE
                 WHEN vector_jobs.status IN ('running', 'pending') THEN vector_jobs.attempt_count
                 ELSE 0
             END,
             available_at = NOW(),
             error_message = NULL,
             published_at = NULL,
             dead_lettered_at = NULL,
             completed_at = NULL,
             updated_at = NOW()
         RETURNING id",
    )
    .bind(dedupe_key)
    .bind(&config.model)
    .bind(config.dimension as i32)
    .bind(target_index)
    .bind(config.retry_max.max(1))
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn recover_leases(pool: &PgPool) -> Result<u64> {
    let result = sqlx::query(
        "UPDATE vector_jobs
         SET status = 'pending',
             attempt_count = GREATEST(attempt_count - 1, 0),
             worker_id = NULL,
             lease_expires_at = NULL,
             available_at = NOW(),
             published_at = NULL,
             error_message = COALESCE(error_message, 'worker lease expired'),
             updated_at = NOW()
         WHERE status = 'running'
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn refresh_active_version_counts(
    pool: &PgPool,
    physical_index: &str,
    actual_chunks: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE vector_index_versions
         SET expected_chunks = (
                 SELECT COUNT(*)::bigint
                 FROM chunks c
                 JOIN documents d
                   ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
                 WHERE d.parse_status = 'indexed'
             ),
             indexed_chunks = $1
         WHERE physical_index = $2 AND status = 'active'",
    )
    .bind(actual_chunks)
    .bind(physical_index)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn cancel_document(pool: &PgPool, doc_id: Uuid) -> Result<u64> {
    let result = sqlx::query(
        "UPDATE vector_jobs
         SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL,
             published_at = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE doc_id = $1 AND status IN ('pending', 'running')",
    )
    .bind(doc_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn claim_next(pool: &PgPool, worker_id: &str) -> Result<Option<VectorJob>> {
    claim(pool, worker_id, None).await
}

pub async fn claim_by_id(pool: &PgPool, worker_id: &str, id: Uuid) -> Result<Option<VectorJob>> {
    claim(pool, worker_id, Some(id)).await
}

async fn claim(
    pool: &PgPool,
    worker_id: &str,
    requested_id: Option<Uuid>,
) -> Result<Option<VectorJob>> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        "SELECT id, operation, tenant_id, kb_id, doc_id, parse_job_id,
                embedding_model, embedding_dim, target_index,
                attempt_count, max_attempts
         FROM vector_jobs
         WHERE status = 'pending' AND available_at <= NOW()
           AND ($1::uuid IS NULL OR id = $1)
         ORDER BY CASE WHEN operation = 'rebuild_index' THEN 0 ELSE 1 END,
                  created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1",
    )
    .bind(requested_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let id: Uuid = row.try_get("id")?;
    let updated = sqlx::query(
        "UPDATE vector_jobs
         SET status = 'running',
             attempt_count = attempt_count + 1,
             worker_id = $1,
             lease_expires_at = NOW() + INTERVAL '10 minutes',
             error_message = NULL,
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = $2 AND status = 'pending'",
    )
    .bind(worker_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        tx.rollback().await?;
        return Ok(None);
    }
    tx.commit().await?;

    Ok(Some(VectorJob {
        id,
        operation: row.try_get("operation")?,
        tenant_id: row.try_get("tenant_id")?,
        kb_id: row.try_get("kb_id")?,
        doc_id: row.try_get("doc_id")?,
        parse_job_id: row.try_get("parse_job_id")?,
        embedding_model: row.try_get("embedding_model")?,
        embedding_dim: row.try_get::<i32, _>("embedding_dim")? as usize,
        target_index: row.try_get("target_index")?,
        attempt_count: row.try_get::<i32, _>("attempt_count")? + 1,
        max_attempts: row.try_get("max_attempts")?,
    }))
}

pub async fn heartbeat(pool: &PgPool, id: Uuid, worker_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE vector_jobs
         SET lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
         WHERE id = $1 AND status = 'running' AND worker_id = $2",
    )
    .bind(id)
    .bind(worker_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn complete(pool: &PgPool, id: Uuid, metadata: serde_json::Value) -> Result<()> {
    sqlx::query(
        "UPDATE vector_jobs
         SET status = 'completed',
             lease_expires_at = NULL,
             worker_id = NULL,
             published_at = NULL,
             error_message = NULL,
             metadata = metadata || $1,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2 AND status = 'running'",
    )
    .bind(metadata)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn pending_for_publish(pool: &PgPool, limit: i64) -> Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "SELECT id FROM vector_jobs
         WHERE status = 'pending' AND available_at <= NOW()
           AND (published_at IS NULL OR published_at < NOW() - INTERVAL '5 minutes')
         ORDER BY CASE WHEN operation = 'rebuild_index' THEN 0 ELSE 1 END,
                  created_at
         LIMIT $1",
    )
    .bind(limit.clamp(1, 1_000))
    .fetch_all(pool)
    .await
    .context("failed to load vector jobs for RabbitMQ publication")
}

pub async fn mark_published(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE vector_jobs
         SET published_at = NOW(), publish_attempt_count = publish_attempt_count + 1,
             updated_at = NOW()
         WHERE id = $1 AND status = 'pending'",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn failed_for_dead_letter(pool: &PgPool, limit: i64) -> Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "SELECT id FROM vector_jobs
         WHERE status = 'failed' AND dead_lettered_at IS NULL
         ORDER BY completed_at, created_at
         LIMIT $1",
    )
    .bind(limit.clamp(1, 1_000))
    .fetch_all(pool)
    .await
    .context("failed to load terminal vector jobs for dead-letter publication")
}

pub async fn mark_dead_lettered(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE vector_jobs SET dead_lettered_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'failed'",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn fail(pool: &PgPool, job: &VectorJob, message: &str) -> Result<bool> {
    let retry = job.attempt_count < job.max_attempts;
    let delay_seconds =
        (5_i32.saturating_mul(2_i32.pow(job.attempt_count.min(6) as u32))).clamp(10, 300);
    let result = sqlx::query(
        "UPDATE vector_jobs
         SET status = CASE WHEN $1 THEN 'pending' ELSE 'failed' END,
             available_at = CASE
                 WHEN $1 THEN NOW() + make_interval(secs => $2)
                 ELSE available_at
             END,
             lease_expires_at = NULL,
             worker_id = NULL,
             published_at = NULL,
             dead_lettered_at = CASE WHEN $1 THEN NULL ELSE dead_lettered_at END,
             error_message = $3,
             completed_at = CASE WHEN $1 THEN NULL ELSE NOW() END,
             updated_at = NOW()
         WHERE id = $4 AND status = 'running'",
    )
    .bind(retry)
    .bind(delay_seconds as f64)
    .bind(message)
    .bind(job.id)
    .execute(pool)
    .await?;
    Ok(retry || result.rows_affected() == 0)
}

pub async fn active_index(pool: &PgPool, alias: &str) -> Result<Option<String>> {
    sqlx::query_scalar(
        "SELECT physical_index FROM vector_index_versions
         WHERE index_alias = $1 AND status = 'active'",
    )
    .bind(alias)
    .fetch_optional(pool)
    .await
    .context("failed to load active vector index")
}

pub async fn retired_indexes(pool: &PgPool, alias: &str) -> Result<Vec<String>> {
    sqlx::query_scalar(
        "SELECT physical_index FROM vector_index_versions
         WHERE index_alias = $1 AND status = 'retired'",
    )
    .bind(alias)
    .fetch_all(pool)
    .await
    .context("failed to load retired vector indices")
}

pub async fn create_building_version(
    tx: &mut Transaction<'_, Postgres>,
    alias: &str,
    physical_index: &str,
    config: &EmbeddingConfig,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO vector_index_versions (
            index_alias, physical_index, embedding_model, embedding_dim,
            schema_version, status
         )
         VALUES ($1, $2, $3, $4, $5, 'building')
         ON CONFLICT (physical_index) DO UPDATE
         SET status = CASE
                 WHEN vector_index_versions.status = 'active' THEN 'active'
                 ELSE 'building'
             END,
             error_message = NULL",
    )
    .bind(alias)
    .bind(physical_index)
    .bind(&config.model)
    .bind(config.dimension as i32)
    .bind(config.index_schema_version as i32)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn activate_version(
    pool: &PgPool,
    alias: &str,
    physical_index: &str,
    expected: i64,
    actual: i64,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE vector_index_versions
         SET status = 'retired', retired_at = NOW()
         WHERE index_alias = $1 AND status = 'active' AND physical_index <> $2",
    )
    .bind(alias)
    .bind(physical_index)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE vector_index_versions
         SET status = 'active', expected_chunks = $1, indexed_chunks = $2,
             error_message = NULL, activated_at = NOW(), retired_at = NULL
         WHERE physical_index = $3",
    )
    .bind(expected)
    .bind(actual)
    .bind(physical_index)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn mark_version_failed(pool: &PgPool, physical_index: &str, error: &str) -> Result<()> {
    sqlx::query(
        "UPDATE vector_index_versions
         SET status = 'failed', error_message = $1
         WHERE physical_index = $2 AND status <> 'active'",
    )
    .bind(error)
    .bind(physical_index)
    .execute(pool)
    .await?;
    Ok(())
}
