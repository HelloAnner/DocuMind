use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use sqlx::Row;

use crate::auth::{require_permission, ActorExtractor};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/diagnostics/vector-indexes", get(list_vector_indexes))
}

async fn list_vector_indexes(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<serde_json::Value>>, crate::error::AppError> {
    require_permission(&actor, "audit.read")?;
    if actor.allowed_kb_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let Some(pool) = &state.db_pool else {
        return Ok(Json(Vec::new()));
    };

    let rows = sqlx::query(
        r#"
        SELECT t.id AS tenant_id,
               t.name AS tenant_name,
               kb.id AS kb_id,
               kb.name AS kb_name,
               COUNT(DISTINCT d.id) FILTER (WHERE d.parse_status = 'indexed')::bigint
                   AS indexed_documents,
               COUNT(DISTINCT d.id) FILTER (
                   WHERE d.parse_status IN ('uploaded', 'parsing', 'chunked', 'embedding')
               )::bigint AS building_documents,
               COUNT(DISTINCT d.id) FILTER (
                   WHERE d.parse_status IN (
                       'parse_failed',
                       'parse_low_confidence',
                       'ocr_pending',
                       'embedding_failed',
                       'parsed'
                   )
               )::bigint AS degraded_documents,
               COUNT(DISTINCT c.id)::bigint AS chunks,
               COUNT(DISTINCT c.id) FILTER (
                   WHERE d.parse_status = 'indexed'
                     AND e.status = 'completed'
                     AND e.index_status = 'indexed'
               )::bigint AS searchable_chunks,
               COUNT(DISTINCT e.chunk_id) FILTER (
                   WHERE e.status = 'completed' AND e.index_status = 'indexed'
               )::bigint AS embedded_chunks,
               COUNT(DISTINCT e.chunk_id) FILTER (
                   WHERE e.status <> 'completed' OR e.index_status = 'failed'
               )::bigint AS failed_embeddings,
               COUNT(DISTINCT c.id) FILTER (
                   WHERE d.parse_status = 'excluded_from_search'
               )::bigint AS excluded_chunks,
               MAX(e.indexed_at) AS last_indexed_at
        FROM knowledge_base kb
        JOIN tenant t ON t.id = kb.tenant_id
        LEFT JOIN documents d
               ON d.kb_id = kb.id
              AND d.tenant_id = kb.tenant_id
              AND d.parse_status <> 'deleted'
        LEFT JOIN chunks c
               ON c.doc_id = d.id
              AND c.tenant_id = d.tenant_id
              AND c.kb_id = d.kb_id
              AND c.parse_job_id = d.latest_parse_job_id
        LEFT JOIN chunk_embeddings e
               ON e.chunk_id = c.id
              AND e.embedding_model = $1
        WHERE kb.tenant_id = $2
          AND kb.id = ANY($3)
        GROUP BY t.id, t.name, kb.id, kb.name
        ORDER BY kb.name ASC
        "#,
    )
    .bind(&state.config.rag.embedding.model)
    .bind(actor.tenant_id)
    .bind(&actor.allowed_kb_ids)
    .fetch_all(pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let chunks = row.get::<i64, _>("chunks");
                let searchable_chunks = row.get::<i64, _>("searchable_chunks");
                let building_documents = row.get::<i64, _>("building_documents");
                let degraded_documents = row.get::<i64, _>("degraded_documents");
                let failed_embeddings = row.get::<i64, _>("failed_embeddings");
                let status = if building_documents > 0 {
                    "building"
                } else if degraded_documents > 0 || failed_embeddings > 0 {
                    "degraded"
                } else {
                    "healthy"
                };
                let kb_id = row.get::<uuid::Uuid, _>("kb_id");
                json!({
                    "id": format!("{}:{}", kb_id, state.config.rag.embedding.model),
                    "name": state.config.rag.embedding.index_name,
                    "alias": state.config.rag.embedding.index_alias,
                    "tenant_id": row.get::<uuid::Uuid, _>("tenant_id"),
                    "tenant": row.get::<String, _>("tenant_name"),
                    "kb_id": kb_id,
                    "kb_name": row.get::<String, _>("kb_name"),
                    "embedding_model": state.config.rag.embedding.model,
                    "index_version": format!(
                        "{}:{}",
                        state.config.rag.embedding.index_alias,
                        state.config.rag.embedding.model
                    ),
                    "dimension": state.config.rag.embedding.dimension,
                    "documents": row.get::<i64, _>("indexed_documents"),
                    "building_documents": building_documents,
                    "degraded_documents": degraded_documents,
                    "chunks": chunks,
                    "searchable_chunks": searchable_chunks,
                    "embedded_chunks": row.get::<i64, _>("embedded_chunks"),
                    "failed_embeddings": failed_embeddings,
                    "excluded_chunks": row.get::<i64, _>("excluded_chunks"),
                    "status": status,
                    "lastIndexed": row
                        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_indexed_at")
                        .map(|value| value.to_rfc3339()),
                })
            })
            .collect(),
    ))
}
