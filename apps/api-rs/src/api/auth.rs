use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::ActorExtractor;
use crate::models::identity::{MeResponse, TenantProfile, UserProfile};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct DevLoginRequest {
    pub email: String,
    pub role: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me", get(get_me))
        .route("/api/auth/login", get(dev_login).post(dev_login))
}

async fn get_me(
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<MeResponse>, crate::error::AppError> {
    Ok(Json(MeResponse {
        user: UserProfile {
            id: actor.user_id,
            email: actor.email.clone(),
            name: if actor.name == actor.email { None } else { Some(actor.name.clone()) },
            avatar_url: None,
            status: "active".to_string(),
        },
        tenant: TenantProfile {
            id: actor.tenant_id,
            name: "Acme Corp".to_string(),
            slug: "acme".to_string(),
            plan: "enterprise".to_string(),
            status: "active".to_string(),
        },
        roles: actor.roles,
        permissions: actor.permissions,
        allowed_kb_ids: actor.allowed_kb_ids,
    }))
}

async fn dev_login(
    State(state): State<AppState>,
    Json(req): Json<DevLoginRequest>,
) -> Result<impl IntoResponse, crate::error::AppError> {
    // Dev login: map email to a fixed seed user id based on requested role.
    let user_id = match req.role.as_str() {
        "super_admin" => Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap(),
        "end_user" => Uuid::parse_str("00000000-0000-0000-0000-000000000004").unwrap(),
        _ => Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap(),
    };
    let tenant_id = state.config.default_tenant_id;
    Ok(Json(json!({
        "user_id": user_id,
        "tenant_id": tenant_id,
        "email": req.email,
        "role": req.role,
        "token": "dev-token",
        "headers": {
            "x-user-id": user_id.to_string(),
            "x-tenant-id": tenant_id.to_string(),
            "x-role": req.role,
        }
    })))
}
