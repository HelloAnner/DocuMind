use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{self, ActorExtractor};
use crate::models::identity::{MeResponse, TenantProfile, UserProfile};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: Option<String>,
    pub email: Option<String>,
    pub password: String,
    pub tenant_id: Option<String>,
    pub tenant_slug: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub token_type: &'static str,
    pub user: UserProfile,
    pub tenant: TenantProfile,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub allowed_kb_ids: Vec<Uuid>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me", get(get_me))
        .route("/api/auth/login", post(login))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/logout", post(logout))
        .route("/api/v1/me", get(get_me))
        .route("/api/v1/auth/me", get(get_me))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/refresh", post(refresh))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/permission/me", get(permission_me))
        .route("/api/v1/permission/matrix", get(permission_matrix))
}

async fn get_me(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<MeResponse>, crate::error::AppError> {
    Ok(Json(me_response(&state, actor).await?))
}

async fn permission_me(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    let me = me_response(&state, actor).await?;
    Ok(Json(json!({
        "user_id": me.user.id,
        "tenant_id": me.tenant.id,
        "roles": me.roles,
        "permissions": me.permissions,
        "allowed_kb_ids": me.allowed_kb_ids,
    })))
}

async fn permission_matrix() -> Json<serde_json::Value> {
    Json(json!({ "roles": auth::role_matrix() }))
}

async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, crate::error::AppError> {
    let username = req
        .username
        .as_deref()
        .or(req.email.as_deref())
        .unwrap_or_default();
    let tenant_key = req.tenant_id.as_deref().or(req.tenant_slug.as_deref());
    let (actor, access_token) =
        auth::authenticate(&state, username, &req.password, tenant_key).await?;
    let me = me_response(&state, actor).await?;
    Ok(Json(LoginResponse {
        access_token,
        token_type: "bearer",
        user: me.user,
        tenant: me.tenant,
        roles: me.roles,
        permissions: me.permissions,
        allowed_kb_ids: me.allowed_kb_ids,
    }))
}

async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LoginResponse>, crate::error::AppError> {
    let claims = auth::claims_from_headers(&state.config, &headers)?;
    auth::validate_and_renew_auth_session(&state, &claims).await?;
    let actor = auth::actor_from_claims(&state, &claims).await?;
    let access_token = auth::issue_token(&state.config, &actor, claims.sid.as_deref())?;
    let me = me_response(&state, actor).await?;
    Ok(Json(LoginResponse {
        access_token,
        token_type: "bearer",
        user: me.user,
        tenant: me.tenant,
        roles: me.roles,
        permissions: me.permissions,
        allowed_kb_ids: me.allowed_kb_ids,
    }))
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    if let Ok(claims) = auth::claims_from_headers(&state.config, &headers) {
        if let Some(session_id) = claims.sid.as_deref() {
            let _ = auth::delete_auth_session(&state, session_id).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

async fn me_response(
    state: &AppState,
    actor: crate::models::CurrentActor,
) -> Result<MeResponse, crate::error::AppError> {
    let tenant = tenant_profile(state, actor.tenant_id).await?;
    Ok(MeResponse {
        user: UserProfile {
            id: actor.user_id,
            email: actor.email.clone(),
            name: if actor.name == actor.email {
                None
            } else {
                Some(actor.name.clone())
            },
            avatar_url: None,
            status: "active".to_string(),
        },
        tenant,
        roles: actor.roles,
        permissions: actor.permissions,
        allowed_kb_ids: actor.allowed_kb_ids,
    })
}

async fn tenant_profile(
    state: &AppState,
    tenant_id: Uuid,
) -> Result<TenantProfile, crate::error::AppError> {
    if let Some(pool) = &state.db_pool {
        if let Some(row) =
            sqlx::query("SELECT id, name, slug, plan, status FROM tenant WHERE id = $1")
                .bind(tenant_id)
                .fetch_optional(pool)
                .await?
        {
            return Ok(TenantProfile {
                id: row.get("id"),
                name: row.get("name"),
                slug: row.get("slug"),
                plan: row.get("plan"),
                status: row.get("status"),
            });
        }
    }

    Ok(TenantProfile {
        id: state.config.default_tenant_id,
        name: state.config.default_tenant_name.clone(),
        slug: state.config.default_tenant_slug.clone(),
        plan: "enterprise".to_string(),
        status: "active".to_string(),
    })
}
