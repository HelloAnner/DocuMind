use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::ActorExtractor;
use crate::models::identity::KnowledgeBaseSummary;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/knowledge-bases", get(list_knowledge_bases))
}

async fn list_knowledge_bases(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<KnowledgeBaseSummary>>, crate::error::AppError> {
    if actor.allowed_kb_ids.is_empty() {
        return Ok(Json(vec![]));
    }

    if let Some(pool) = &state.db_pool {
        let rows = sqlx::query(
            "SELECT kb.id, kb.tenant_id, kb.name, kb.description, kb.status, kb.tags,
                    COUNT(DISTINCT d.id)::bigint AS doc_count,
                    COUNT(c.id)::bigint AS chunk_count,
                    kb.updated_at
             FROM knowledge_base kb
             LEFT JOIN documents d
                    ON d.kb_id = kb.id
                   AND d.tenant_id = kb.tenant_id
                   AND d.parse_status <> 'deleted'
             LEFT JOIN chunks c
                    ON c.doc_id = d.id
                   AND d.latest_parse_job_id = c.parse_job_id
             WHERE kb.tenant_id = $1 AND kb.id = ANY($2)
             GROUP BY kb.id
             ORDER BY kb.updated_at DESC",
        )
        .bind(actor.tenant_id)
        .bind(&actor.allowed_kb_ids)
        .fetch_all(pool)
        .await?;

        let summaries = rows
            .into_iter()
            .map(|row| KnowledgeBaseSummary {
                id: row.get("id"),
                tenant_id: row.get("tenant_id"),
                name: row.get("name"),
                description: row.get("description"),
                status: row.get("status"),
                tags: row.get("tags"),
                doc_count: row.get("doc_count"),
                chunk_count: row.get("chunk_count"),
                query_count: 0,
                updated_at: row.get("updated_at"),
            })
            .collect();
        return Ok(Json(summaries));
    }

    Ok(Json(vec![KnowledgeBaseSummary {
        id: state
            .config
            .default_kb_ids
            .first()
            .copied()
            .unwrap_or_else(Uuid::nil),
        tenant_id: actor.tenant_id,
        name: "产品文档库".to_string(),
        description: Some("面向全公司的产品手册与白皮书集合".to_string()),
        status: "active".to_string(),
        tags: vec!["产品".to_string()],
        doc_count: 3201,
        chunk_count: 4832,
        query_count: 1204,
        updated_at: chrono::Utc::now(),
    }]))
}
