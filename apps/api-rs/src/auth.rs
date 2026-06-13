use std::convert::Infallible;

use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::Uuid;

use crate::models::ActorScope;
use crate::state::AppState;

pub struct ActorExtractor(pub ActorScope);

#[async_trait]
impl FromRequestParts<AppState> for ActorExtractor {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let cfg = &state.config;
        let headers = &parts.headers;
        let tenant_id = headers
            .get("x-tenant-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| Uuid::parse_str(v).ok())
            .unwrap_or(cfg.default_tenant_id);
        let user_id = headers
            .get("x-user-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| Uuid::parse_str(v).ok())
            .unwrap_or(cfg.default_user_id);
        let role = headers
            .get("x-role")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string())
            .unwrap_or_else(|| cfg.default_role.clone());

        let allowed_kb_ids = cfg.default_kb_ids.clone();

        Ok(ActorExtractor(ActorScope {
            tenant_id,
            user_id,
            role,
            allowed_kb_ids,
        }))
    }
}
