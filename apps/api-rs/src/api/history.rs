use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::ActorExtractor;
use crate::models::conversation::ConversationListResponse;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    cursor: Option<String>,
}

fn default_limit() -> usize {
    50
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/history", get(list_history))
}

async fn list_history(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<ConversationListResponse>, crate::error::AppError> {
    let resp = state
        .repository
        .list_sessions(actor.tenant_id, actor.user_id, query.limit, query.cursor)
        .await?;
    Ok(Json(resp))
}
