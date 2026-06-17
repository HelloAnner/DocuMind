use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
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
        let rows = sqlx::query_as::<
            _,
            (
                Uuid,
                Uuid,
                String,
                Option<String>,
                String,
                Vec<String>,
                chrono::DateTime<chrono::Utc>,
            ),
        >(
            "SELECT id, tenant_id, name, description, status, tags, updated_at
             FROM knowledge_base
             WHERE tenant_id = $1 AND id = ANY($2)
             ORDER BY updated_at DESC",
        )
        .bind(actor.tenant_id)
        .bind(&actor.allowed_kb_ids)
        .fetch_all(pool)
        .await?;

        let summaries = rows
            .into_iter()
            .map(
                |(id, tenant_id, name, description, status, tags, updated_at)| {
                    KnowledgeBaseSummary {
                        id,
                        tenant_id,
                        name,
                        description,
                        status,
                        tags,
                        doc_count: 0,
                        chunk_count: 0,
                        query_count: 0,
                        updated_at,
                    }
                },
            )
            .collect();
        return Ok(Json(summaries));
    }

    Ok(Json(vec![KnowledgeBaseSummary {
        id: state
            .config
            .default_kb_ids
            .get(0)
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
