use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::api::auth::LoginResponse;
use crate::auth::{self, ActorExtractor};
use crate::error::AppError;
use crate::models::identity::MeResponse;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct UpdateProfileRequest {
    name: String,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SwitchTenantRequest {
    tenant_id: Uuid,
}

#[derive(Debug, Serialize)]
struct AccountTenantSummary {
    id: Uuid,
    name: String,
    slug: String,
    status: String,
    roles: Vec<String>,
    current: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/account/profile", get(profile).patch(update_profile))
        .route("/api/account/tenants", get(list_account_tenants))
        .route("/api/account/switch-tenant", post(switch_tenant))
}

async fn profile(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<MeResponse>, AppError> {
    Ok(Json(super::auth::me_response(&state, actor).await?))
}

async fn update_profile(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<UpdateProfileRequest>,
) -> Result<Json<MeResponse>, AppError> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 128 {
        return Err(AppError::bad_request(
            "PROFILE_NAME_INVALID",
            "姓名不能为空且不能超过 128 个字符",
        ));
    }
    let avatar_url = req
        .avatar_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if avatar_url.is_some_and(|value| value.chars().count() > 2048) {
        return Err(AppError::bad_request(
            "PROFILE_AVATAR_URL_INVALID",
            "头像地址不能超过 2048 个字符",
        ));
    }
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "个人资料功能需要数据库"))?;
    sqlx::query("UPDATE app_user SET name = $2, avatar_url = $3, updated_at = NOW() WHERE id = $1")
        .bind(actor.user_id)
        .bind(name)
        .bind(avatar_url)
        .execute(pool)
        .await?;

    let refreshed = auth::actor_from_claims(
        &state,
        &auth::Claims {
            sub: actor.user_id,
            email: actor.email,
            role: actor
                .roles
                .first()
                .cloned()
                .unwrap_or_else(|| "end_user".to_string()),
            tenant_id: actor.tenant_id,
            sid: None,
            exp: (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp() as usize,
        },
    )
    .await?;
    auth::record_audit_event(
        &state,
        Some(&refreshed),
        "account.profile.update",
        Some("app_user"),
        Some(&refreshed.user_id.to_string()),
        json!({ "name": name, "avatar_configured": avatar_url.is_some() }),
    )
    .await?;
    Ok(Json(super::auth::me_response(&state, refreshed).await?))
}

async fn list_account_tenants(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<AccountTenantSummary>>, AppError> {
    if actor.is_super_admin {
        return Ok(Json(Vec::new()));
    }
    let Some(pool) = &state.db_pool else {
        return Ok(Json(vec![AccountTenantSummary {
            id: actor.tenant_id,
            name: state.config.default_tenant_name.clone(),
            slug: state.config.default_tenant_slug.clone(),
            status: "active".to_string(),
            roles: actor.roles,
            current: true,
        }]));
    };

    let rows = sqlx::query(
        r#"
        SELECT t.id, t.name, t.slug, t.status, tm.roles
        FROM tenant_member tm
        JOIN tenant t ON t.id = tm.tenant_id
        WHERE tm.user_id = $1
          AND tm.status = 'active'
          AND t.status = 'active'
          AND NOT ('super_admin' = ANY(tm.roles))
        ORDER BY t.name ASC
        "#,
    )
    .bind(actor.user_id)
    .fetch_all(pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let id: Uuid = row.get("id");
                AccountTenantSummary {
                    id,
                    name: row.get("name"),
                    slug: row.get("slug"),
                    status: row.get("status"),
                    roles: row.get("roles"),
                    current: id == actor.tenant_id,
                }
            })
            .collect(),
    ))
}

async fn switch_tenant(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<SwitchTenantRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    if actor.is_super_admin {
        return Err(AppError::Forbidden {
            code: "PLATFORM_ADMIN_TENANT_SWITCH_FORBIDDEN".to_string(),
            message: "平台管理员不能进入租户数据空间".to_string(),
        });
    }
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "租户切换功能需要数据库"))?;
    let membership_exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM tenant_member tm
            JOIN tenant t ON t.id = tm.tenant_id
            WHERE tm.user_id = $1
              AND tm.tenant_id = $2
              AND tm.status = 'active'
              AND t.status = 'active'
              AND NOT ('super_admin' = ANY(tm.roles))
        )
        "#,
    )
    .bind(actor.user_id)
    .bind(req.tenant_id)
    .fetch_one(pool)
    .await?;
    if !membership_exists {
        return Err(AppError::Forbidden {
            code: "TENANT_MEMBERSHIP_NOT_FOUND".to_string(),
            message: "当前账号不属于该租户或租户不可用".to_string(),
        });
    }

    sqlx::query("UPDATE app_user SET last_active_tenant = $2, updated_at = NOW() WHERE id = $1")
        .bind(actor.user_id)
        .bind(req.tenant_id)
        .execute(pool)
        .await?;

    let switched = auth::actor_from_claims(
        &state,
        &auth::Claims {
            sub: actor.user_id,
            email: actor.email,
            role: "end_user".to_string(),
            tenant_id: req.tenant_id,
            sid: None,
            exp: (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp() as usize,
        },
    )
    .await?;
    let session_id = auth::create_auth_session(&state, &switched).await?;
    let access_token = auth::issue_token(&state.config, &switched, Some(&session_id))?;
    auth::record_audit_event(
        &state,
        Some(&switched),
        "account.tenant.switch",
        Some("tenant"),
        Some(&req.tenant_id.to_string()),
        json!({ "previous_tenant_id": actor.tenant_id }),
    )
    .await?;
    let me = super::auth::me_response(&state, switched).await?;
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
