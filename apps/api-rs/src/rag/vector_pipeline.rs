use std::collections::HashSet;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::config::EmbeddingConfig;
use crate::rag::embedding::{EmbeddingClient, EmbeddingClientConfig};
use crate::rag::vector_document::index_document;
use crate::rag::vector_index::{
    physical_index_name, ElasticsearchChunkIndexer, ElasticsearchConfig,
};
use crate::rag::{vector_jobs, vector_store};

#[derive(Debug, Clone, Serialize)]
pub struct VectorConsistency {
    pub index_alias: String,
    pub physical_index: Option<String>,
    pub expected_chunks: i64,
    pub actual_chunks: i64,
    pub missing_chunks: i64,
    pub stale_chunks: i64,
    pub missing_or_stale_chunks: i64,
    pub consistent: bool,
}

pub fn start_vector_worker(
    pool: PgPool,
    config: EmbeddingConfig,
    es_url: Option<String>,
    rabbitmq_url: Option<String>,
) {
    if !config.enabled {
        info!("vector worker disabled because embedding is disabled");
        return;
    }
    let Some(es_url) = es_url else {
        error!("vector worker disabled because ELASTICSEARCH_URL is missing");
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = run_worker(pool, config, es_url, rabbitmq_url).await {
            error!(error = %error, "vector worker stopped unexpectedly");
        }
    });
}

pub async fn enqueue_document(
    pool: &PgPool,
    tenant_id: Uuid,
    kb_id: Uuid,
    doc_id: Uuid,
    parse_job_id: Uuid,
    config: &EmbeddingConfig,
    force: bool,
) -> Result<Uuid> {
    let target = vector_jobs::active_index(pool, &config.index_alias)
        .await?
        .unwrap_or_else(|| desired_index(config));
    vector_jobs::enqueue_document(
        pool,
        tenant_id,
        kb_id,
        doc_id,
        parse_job_id,
        &target,
        config,
        force,
    )
    .await
}

pub async fn schedule_rebuild(pool: &PgPool, config: &EmbeddingConfig) -> Result<(Uuid, String)> {
    if has_open_rebuild(pool, &config.index_alias).await? {
        let row = sqlx::query(
            "SELECT id, target_index FROM vector_jobs
             WHERE operation = 'rebuild_index' AND status IN ('pending', 'running')
               AND embedding_model = $1
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&config.model)
        .fetch_one(pool)
        .await?;
        return Ok((row.try_get("id")?, row.try_get("target_index")?));
    }
    let base = desired_index(config);
    let active = vector_jobs::active_index(pool, &config.index_alias).await?;
    let target = if active.as_deref() == Some(base.as_str()) {
        format!("{base}-r{}", Utc::now().timestamp_millis())
    } else {
        base
    };
    let mut tx = pool.begin().await?;
    vector_jobs::create_building_version(&mut tx, &config.index_alias, &target, config).await?;
    tx.commit().await?;
    let id = vector_jobs::enqueue_rebuild(pool, &target, config).await?;
    Ok((id, target))
}

pub async fn consistency(
    pool: &PgPool,
    config: &EmbeddingConfig,
    es_url: &str,
) -> Result<VectorConsistency> {
    let physical_index = vector_jobs::active_index(pool, &config.index_alias).await?;
    let expected_ids = expected_chunk_ids(pool).await?;
    let actual_ids = if let Some(index) = &physical_index {
        indexer(es_url, index, config)?.chunk_ids().await?
    } else {
        HashSet::new()
    };
    let missing = expected_ids.difference(&actual_ids).count() as i64;
    let stale = actual_ids.difference(&expected_ids).count() as i64;
    Ok(VectorConsistency {
        index_alias: config.index_alias.clone(),
        physical_index,
        expected_chunks: expected_ids.len() as i64,
        actual_chunks: actual_ids.len() as i64,
        missing_chunks: missing,
        stale_chunks: stale,
        missing_or_stale_chunks: missing + stale,
        consistent: missing == 0 && stale == 0,
    })
}

pub async fn quick_consistency(
    pool: &PgPool,
    config: &EmbeddingConfig,
    es_url: &str,
) -> Result<VectorConsistency> {
    let physical_index = vector_jobs::active_index(pool, &config.index_alias).await?;
    let expected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint
         FROM chunks c
         JOIN documents d ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
         WHERE d.parse_status = 'indexed'",
    )
    .fetch_one(pool)
    .await?;
    let actual = if let Some(index) = &physical_index {
        indexer(es_url, index, config)?.count().await? as i64
    } else {
        0
    };
    let missing = (expected - actual).max(0);
    let stale = (actual - expected).max(0);
    Ok(VectorConsistency {
        index_alias: config.index_alias.clone(),
        physical_index,
        expected_chunks: expected,
        actual_chunks: actual,
        missing_chunks: missing,
        stale_chunks: stale,
        missing_or_stale_chunks: missing + stale,
        consistent: expected == actual,
    })
}

async fn run_worker(
    pool: PgPool,
    config: EmbeddingConfig,
    es_url: String,
    rabbitmq_url: Option<String>,
) -> Result<()> {
    let client_config = EmbeddingClientConfig::try_from(&config)?;
    let embedding_client = EmbeddingClient::new(client_config)?;
    let worker_id = format!("vector-worker-{}", Uuid::new_v4());
    vector_store::reconcile_legacy_embeddings(&pool).await?;
    recover_expired_leases(&pool).await?;
    bootstrap_jobs(&pool, &config, &es_url).await?;
    let (queue_sender, mut queue_receiver) = tokio::sync::mpsc::channel(1_024);
    if let Some(rabbitmq_url) = rabbitmq_url {
        crate::rag::vector_queue::start(rabbitmq_url, pool.clone(), queue_sender);
    }

    let poll = Duration::from_millis(config.worker_poll_ms.clamp(250, 60_000));
    let lease_recovery_ticks = (30_000 / poll.as_millis().max(1) as u64).max(1);
    let mut idle_ticks = 0_u64;
    loop {
        let queued_job_id = queue_receiver.try_recv().ok();
        let claimed = if let Some(job_id) = queued_job_id {
            vector_jobs::claim_by_id(&pool, &worker_id, job_id).await?
        } else {
            vector_jobs::claim_next(&pool, &worker_id).await?
        };
        match claimed {
            Some(job) => {
                idle_ticks = 0;
                let result =
                    process_job(&pool, &config, &es_url, &embedding_client, &worker_id, &job).await;
                match result {
                    Ok(metadata) => {
                        vector_jobs::complete(&pool, job.id, metadata).await?;
                    }
                    Err(error) => {
                        let message = format!("{error:#}");
                        let retry = vector_jobs::fail(&pool, &job, &message).await?;
                        warn!(job_id = %job.id, operation = %job.operation, retry, error = %message, "vector job failed");
                        if !retry {
                            if let Some(doc_id) = job.doc_id {
                                vector_store::mark_document_terminal_failure(
                                    &pool,
                                    doc_id,
                                    job.parse_job_id,
                                    &config.model,
                                    &message,
                                )
                                .await?;
                            }
                            if job.operation == "rebuild_index" {
                                vector_jobs::mark_version_failed(
                                    &pool,
                                    &job.target_index,
                                    &message,
                                )
                                .await?;
                            }
                        }
                    }
                }
            }
            None => {
                idle_ticks += 1;
                if idle_ticks % lease_recovery_ticks == 0 {
                    recover_expired_leases(&pool).await?;
                }
                if idle_ticks.saturating_mul(poll.as_millis() as u64) >= 60_000 {
                    idle_ticks = 0;
                    if let Err(error) = ensure_consistency(&pool, &config, &es_url).await {
                        warn!(error = %error, "periodic vector consistency check failed");
                    }
                }
                tokio::time::sleep(poll).await;
            }
        }
    }
}

async fn recover_expired_leases(pool: &PgPool) -> Result<()> {
    let recovered = vector_jobs::recover_leases(pool).await?;
    if recovered > 0 {
        warn!(recovered, "recovered expired vector job leases");
    }
    Ok(())
}

async fn bootstrap_jobs(pool: &PgPool, config: &EmbeddingConfig, es_url: &str) -> Result<()> {
    let desired = desired_index(config);
    let desired_indexer = indexer(es_url, &desired, config)?;
    let alias_targets = desired_indexer.alias_targets().await?;
    let active = vector_jobs::active_index(pool, &config.index_alias).await?;
    let alias_ready = alias_targets.len() == 1 && alias_targets.first() == Some(&desired);
    if active.as_deref() != Some(desired.as_str()) || !alias_ready {
        schedule_rebuild(pool, config).await?;
    } else {
        ensure_consistency(pool, config, es_url).await?;
    }

    let rows = sqlx::query(
        "SELECT tenant_id, kb_id, id, latest_parse_job_id
         FROM documents
         WHERE parse_status IN ('chunked', 'embedding')
           AND latest_parse_job_id IS NOT NULL AND chunk_count > 0",
    )
    .fetch_all(pool)
    .await?;
    for row in rows {
        enqueue_document(
            pool,
            row.try_get("tenant_id")?,
            row.try_get("kb_id")?,
            row.try_get("id")?,
            row.try_get("latest_parse_job_id")?,
            config,
            true,
        )
        .await?;
    }
    Ok(())
}

async fn process_job(
    pool: &PgPool,
    config: &EmbeddingConfig,
    es_url: &str,
    embedding_client: &EmbeddingClient,
    worker_id: &str,
    job: &vector_jobs::VectorJob,
) -> Result<serde_json::Value> {
    if job.embedding_model != config.model || job.embedding_dim != config.dimension {
        bail!("vector job model or dimension no longer matches runtime configuration");
    }
    match job.operation.as_str() {
        "index_document" => {
            let doc_id = job.doc_id.context("index_document job is missing doc_id")?;
            let parse_job_id = job
                .parse_job_id
                .context("index_document job is missing parse_job_id")?;
            let target = vector_jobs::active_index(pool, &config.index_alias)
                .await?
                .unwrap_or_else(|| job.target_index.clone());
            let outcome = index_document(
                pool,
                embedding_client,
                &indexer(es_url, &target, config)?,
                doc_id,
                parse_job_id,
                config,
            )
            .await?;
            Ok(json!({
                "physical_index": target,
                "indexed_chunks": outcome.indexed_chunks,
                "generated_embeddings": outcome.generated_embeddings,
                "reused_embeddings": outcome.reused_embeddings,
                "skipped": outcome.skipped,
            }))
        }
        "rebuild_index" => {
            rebuild_index(pool, config, es_url, embedding_client, worker_id, job).await
        }
        operation => Err(anyhow!("unsupported vector job operation {operation}")),
    }
}

async fn rebuild_index(
    pool: &PgPool,
    config: &EmbeddingConfig,
    es_url: &str,
    embedding_client: &EmbeddingClient,
    worker_id: &str,
    job: &vector_jobs::VectorJob,
) -> Result<serde_json::Value> {
    let indexer = indexer(es_url, &job.target_index, config)?;
    let attached = indexer.alias_targets().await?;
    if attached.iter().any(|index| index == &job.target_index) {
        let (expected, actual) = verify_index_contents(pool, &indexer).await?;
        let previous = indexer.switch_alias().await?;
        vector_jobs::activate_version(
            pool,
            &config.index_alias,
            &job.target_index,
            expected,
            actual,
        )
        .await?;
        for retired in previous.iter().filter(|index| *index != &job.target_index) {
            indexer.delete_index(retired).await?;
        }
        for retired in vector_jobs::retired_indexes(pool, &config.index_alias).await? {
            if retired != job.target_index {
                indexer.delete_index(&retired).await?;
            }
        }
        if config.index_name != job.target_index && !previous.contains(&config.index_name) {
            indexer.delete_index(&config.index_name).await?;
        }
        return Ok(json!({
            "physical_index": job.target_index,
            "expected_chunks": expected,
            "actual_chunks": actual,
            "recovered_alias_activation": true,
            "retired_indices": previous,
        }));
    }
    indexer.reset_inactive_index(config.dimension).await?;
    let documents = sqlx::query(
        "SELECT id, latest_parse_job_id
         FROM documents
         WHERE parse_status = 'indexed'
           AND latest_parse_job_id IS NOT NULL AND chunk_count > 0
         ORDER BY updated_at, id",
    )
    .fetch_all(pool)
    .await?;
    let mut indexed_documents = 0usize;
    for row in documents {
        vector_jobs::heartbeat(pool, job.id, worker_id).await?;
        let outcome = index_document(
            pool,
            embedding_client,
            &indexer,
            row.try_get("id")?,
            row.try_get("latest_parse_job_id")?,
            config,
        )
        .await?;
        if !outcome.skipped {
            indexed_documents += 1;
        }
    }
    indexer.refresh().await?;
    let (expected, actual) = verify_index_contents(pool, &indexer).await?;
    let previous = indexer.switch_alias().await?;
    vector_jobs::activate_version(
        pool,
        &config.index_alias,
        &job.target_index,
        expected,
        actual,
    )
    .await?;
    for retired in previous.iter().filter(|index| *index != &job.target_index) {
        indexer.delete_index(retired).await?;
    }
    info!(physical_index = %job.target_index, expected, actual, "activated rebuilt vector index");
    Ok(json!({
        "physical_index": job.target_index,
        "indexed_documents": indexed_documents,
        "expected_chunks": expected,
        "actual_chunks": actual,
        "retired_indices": previous,
    }))
}

async fn verify_index_contents(
    pool: &PgPool,
    indexer: &ElasticsearchChunkIndexer,
) -> Result<(i64, i64)> {
    let expected_ids = expected_chunk_ids(pool).await?;
    let actual_ids = indexer.chunk_ids().await?;
    let missing = expected_ids.difference(&actual_ids).count();
    let stale = actual_ids.difference(&expected_ids).count();
    if missing > 0 || stale > 0 {
        bail!("vector index has {missing} missing and {stale} stale chunks");
    }
    Ok((expected_ids.len() as i64, actual_ids.len() as i64))
}

async fn ensure_consistency(pool: &PgPool, config: &EmbeddingConfig, es_url: &str) -> Result<()> {
    let snapshot = consistency(pool, config, es_url).await?;
    if snapshot.consistent {
        if let Some(index) = snapshot.physical_index.as_deref() {
            vector_store::mark_current_embeddings_indexed(pool, &config.model, index).await?;
            vector_jobs::refresh_active_version_counts(pool, index, snapshot.actual_chunks).await?;
        }
    } else if !has_open_rebuild(pool, &config.index_alias).await? {
        warn!(
            expected = snapshot.expected_chunks,
            actual = snapshot.actual_chunks,
            "vector index drift detected; scheduling rebuild"
        );
        schedule_rebuild(pool, config).await?;
    }
    Ok(())
}

async fn expected_chunk_ids(pool: &PgPool) -> Result<HashSet<Uuid>> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT c.id
         FROM chunks c
         JOIN documents d ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
         WHERE d.parse_status = 'indexed'",
    )
    .fetch_all(pool)
    .await
    .context("failed to load current indexed chunk identifiers")?;
    Ok(ids.into_iter().collect())
}

async fn has_open_rebuild(pool: &PgPool, alias: &str) -> Result<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM vector_jobs j
            JOIN vector_index_versions v ON v.physical_index = j.target_index
            WHERE j.operation = 'rebuild_index' AND j.status IN ('pending', 'running')
              AND v.index_alias = $1
         )",
    )
    .bind(alias)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

fn desired_index(config: &EmbeddingConfig) -> String {
    let version = config.index_schema_version;
    physical_index_name(&config.index_name, &config.model, config.dimension, version)
}

fn indexer(
    es_url: &str,
    physical_index: &str,
    config: &EmbeddingConfig,
) -> Result<ElasticsearchChunkIndexer> {
    ElasticsearchChunkIndexer::new(ElasticsearchConfig {
        base_url: es_url.to_string(),
        index_name: physical_index.to_string(),
        alias_name: config.index_alias.clone(),
        timeout_seconds: 120,
    })
}
