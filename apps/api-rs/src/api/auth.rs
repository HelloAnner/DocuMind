use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{self, ActorExtractor};
use crate::error::AppError;
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
        .route("/auth/portal/callback", get(portal_callback))
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

#[derive(Debug, Deserialize)]
struct PortalCallbackQuery {
    code: String,
}

#[derive(Debug, Serialize)]
struct PortalExchangeRequest {
    system_code: &'static str,
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortalContext {
    user_id: String,
    username: String,
    display_name: String,
    email: Option<String>,
    tenant_id: Uuid,
    tenant_code: Option<String>,
    tenant_name: Option<String>,
    system_code: String,
    #[serde(default)]
    portal_roles: Vec<String>,
    #[serde(default)]
    system_roles: Vec<String>,
    #[serde(default)]
    permissions: Vec<String>,
    expires_at: i64,
}

async fn portal_callback(
    State(state): State<AppState>,
    Query(query): Query<PortalCallbackQuery>,
) -> Response {
    match portal_callback_inner(&state, query).await {
        Ok(response) => response,
        Err(err) => {
            let _ = auth::record_audit_event(
                &state,
                None,
                "portal.login.failure",
                Some("auth_session"),
                None,
                json!({
                    "failure_reason": portal_error_code(&err),
                }),
            )
            .await;
            portal_callback_error(err)
        }
    }
}

async fn portal_callback_inner(
    state: &AppState,
    query: PortalCallbackQuery,
) -> Result<Response, AppError> {
    if state.config.auth_login_mode != "portal" {
        return Err(AppError::unauthorized());
    }
    let portal = exchange_portal_ticket(state, query.code).await?;
    if portal.system_code != "documind" || portal.expires_at < chrono::Utc::now().timestamp() {
        return Err(AppError::unauthorized());
    }
    let roles = map_documind_roles(&portal);
    let provisioned = provision_portal_actor(state, &portal, &roles).await?;
    let session_id = auth::create_auth_session(state, &provisioned.actor).await?;
    let token = auth::issue_token(&state.config, &provisioned.actor, Some(&session_id))?;
    let identity_action = if provisioned.identity_created {
        "portal.identity.link.created"
    } else {
        "portal.identity.link.updated"
    };
    let detail = json!({
        "portal_user_id": portal.user_id,
        "portal_tenant_id": portal.tenant_id,
        "local_user_id": provisioned.actor.user_id,
        "local_tenant_id": provisioned.actor.tenant_id,
        "system_roles": portal.system_roles,
        "portal_roles": portal.portal_roles,
        "portal_permissions": portal.permissions,
        "effective_permissions": provisioned.effective_permissions,
        "allowed_kb_ids": provisioned.actor.allowed_kb_ids,
    });
    auth::record_audit_event(
        state,
        Some(&provisioned.actor),
        identity_action,
        Some("app_user"),
        Some(&provisioned.actor.user_id.to_string()),
        detail.clone(),
    )
    .await?;
    if provisioned.was_clamped {
        auth::record_audit_event(
            state,
            Some(&provisioned.actor),
            "portal.permission.clamped",
            Some("tenant_member"),
            Some(&provisioned.actor.tenant_id.to_string()),
            detail.clone(),
        )
        .await?;
    }
    auth::record_audit_event(
        state,
        Some(&provisioned.actor),
        "portal.login.success",
        Some("auth_session"),
        Some(&session_id),
        detail,
    )
    .await?;
    Ok(portal_success_html(&token, &provisioned.actor).into_response())
}

async fn exchange_portal_ticket(state: &AppState, code: String) -> Result<PortalContext, AppError> {
    let base = state.config.portal_base_url.trim_end_matches('/');
    let endpoint = if state.config.portal_exchange_endpoint.starts_with('/') {
        format!("{base}{}", state.config.portal_exchange_endpoint)
    } else {
        format!("{base}/{}", state.config.portal_exchange_endpoint)
    };
    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&PortalExchangeRequest {
            system_code: "documind",
            code,
        })
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(AppError::unauthorized());
    }
    Ok(response.json::<PortalContext>().await?)
}

struct PortalProvisionResult {
    actor: crate::models::CurrentActor,
    identity_created: bool,
    was_clamped: bool,
    effective_permissions: Vec<String>,
}

async fn provision_portal_actor(
    state: &AppState,
    portal: &PortalContext,
    roles: &[String],
) -> Result<PortalProvisionResult, AppError> {
    let Some(pool) = &state.db_pool else {
        return Err(AppError::bad_request(
            "PORTAL_REQUIRES_DB",
            "database is required for portal managed auth",
        ));
    };
    let tenant_name = portal
        .tenant_name
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("Portal Tenant");
    let tenant_slug = portal
        .tenant_code
        .as_deref()
        .map(slugify)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            format!(
                "tenant-{}",
                portal
                    .tenant_id
                    .to_string()
                    .chars()
                    .take(8)
                    .collect::<String>()
            )
        });

    sqlx::query(
        r#"
        INSERT INTO tenant (id, name, slug, status)
        VALUES ($1, $2, $3, 'active')
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            slug = EXCLUDED.slug,
            status = 'active',
            updated_at = NOW()
        "#,
    )
    .bind(portal.tenant_id)
    .bind(tenant_name)
    .bind(&tenant_slug)
    .execute(pool)
    .await?;

    let email = portal
        .email
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("{}@portal.local", portal.user_id));
    let display_name = if portal.display_name.trim().is_empty() {
        portal.username.clone()
    } else {
        portal.display_name.clone()
    };
    let existing_user_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM app_user WHERE auth_provider = 'portal' AND sso_subject = $1 LIMIT 1",
    )
    .bind(&portal.user_id)
    .fetch_optional(pool)
    .await?;
    let identity_created = existing_user_id.is_none();
    let existing_user_id = match existing_user_id {
        Some(id) => Some(id),
        None => {
            sqlx::query_scalar("SELECT id FROM app_user WHERE lower(email) = lower($1) LIMIT 1")
                .bind(&email)
                .fetch_optional(pool)
                .await?
        }
    };
    let user_id = existing_user_id.unwrap_or_else(Uuid::new_v4);
    let local_permissions = auth::derive_permissions(roles);
    let mapped_portal_permissions = map_portal_permissions(&portal.permissions);
    let effective_permissions =
        intersect_permissions(&local_permissions, &mapped_portal_permissions);
    let was_clamped = effective_permissions.len() < local_permissions.len();
    let attributes = json!({
        "auth_provider": "portal",
        "portal_user_id": portal.user_id,
        "portal_tenant_id": portal.tenant_id,
        "portal_permissions": portal.permissions,
        "mapped_portal_permissions": mapped_portal_permissions,
        "effective_permissions": effective_permissions,
        "system_roles": portal.system_roles,
        "portal_roles": portal.portal_roles,
    });
    sqlx::query(
        r#"
        INSERT INTO app_user
          (id, email, name, auth_provider, sso_subject, last_active_tenant, status)
        VALUES ($1, $2, $3, 'portal', $4, $5, 'active')
        ON CONFLICT (id) DO UPDATE
        SET email = EXCLUDED.email,
            name = EXCLUDED.name,
            auth_provider = 'portal',
            sso_subject = EXCLUDED.sso_subject,
            last_active_tenant = EXCLUDED.last_active_tenant,
            status = 'active',
            updated_at = NOW()
        "#,
    )
    .bind(user_id)
    .bind(&email)
    .bind(&display_name)
    .bind(&portal.user_id)
    .bind(portal.tenant_id)
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO tenant_member (tenant_id, user_id, roles, attributes, status, joined_at, last_seen_at)
        VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
        ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET roles = EXCLUDED.roles,
            attributes = EXCLUDED.attributes,
            status = 'active',
            last_seen_at = NOW()
        "#,
    )
    .bind(portal.tenant_id)
    .bind(user_id)
    .bind(roles)
    .bind(&attributes)
    .execute(pool)
    .await?;

    let claims = auth::Claims {
        sub: user_id,
        email,
        role: roles.first().cloned().unwrap_or_else(|| "user".to_string()),
        tenant_id: portal.tenant_id,
        sid: None,
        exp: (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp() as usize,
    };
    let actor = auth::actor_from_claims(state, &claims).await?;
    Ok(PortalProvisionResult {
        actor,
        identity_created,
        was_clamped,
        effective_permissions,
    })
}

fn map_documind_roles(portal: &PortalContext) -> Vec<String> {
    let mut mapped: Vec<String> = Vec::new();
    for role in portal
        .system_roles
        .iter()
        .filter_map(|role| map_documind_role(role))
        .chain(
            portal
                .portal_roles
                .iter()
                .filter_map(|role| map_portal_role_for_documind(role)),
        )
    {
        let value = role;
        if !mapped.iter().any(|r| r == &value) {
            mapped.push(value);
        }
    }
    if mapped.is_empty() {
        mapped.push("user".to_string());
    }
    sort_documind_roles_by_priority(mapped)
}

fn map_portal_permissions(values: &[String]) -> Vec<String> {
    let mut permissions = values
        .iter()
        .filter_map(|value| map_portal_permission(value))
        .collect::<Vec<_>>();
    permissions.sort();
    permissions.dedup();
    permissions
}

fn map_portal_permission(value: &str) -> Option<String> {
    match value.trim() {
        "documind:chat:ask" | "chat.ask" => Some("chat.ask".to_string()),
        "documind:knowledge:read" | "kb.read" => Some("kb.read".to_string()),
        "documind:knowledge:create" | "kb.create" => Some("kb.create".to_string()),
        "documind:knowledge:write" | "kb.write" => Some("kb.write".to_string()),
        "documind:knowledge:manage" | "kb.manage" => Some("kb.manage".to_string()),
        "documind:document:upload" | "document.upload" => Some("document.upload".to_string()),
        "documind:document:delete" | "document.delete" => Some("document.delete".to_string()),
        "documind:document:reprocess" | "document.reprocess" => {
            Some("document.reprocess".to_string())
        }
        "documind:member:read" | "member.read" => Some("member.read".to_string()),
        "documind:member:write" | "member.write" => Some("member.write".to_string()),
        "documind:member:delete" | "member.delete" => Some("member.delete".to_string()),
        "documind:config:read" | "config.read" => Some("config.read".to_string()),
        "documind:config:write" | "config.write" => Some("config.write".to_string()),
        "documind:audit:read" | "audit.read" => Some("audit.read".to_string()),
        "documind:model:manage" | "model.write" => Some("model.write".to_string()),
        "documind:answer:feedback" | "answer.feedback" => Some("answer.feedback".to_string()),
        "documind:tenant:read" | "tenant.read" => Some("tenant.read".to_string()),
        "documind:tenant:write" | "tenant.write" => Some("tenant.write".to_string()),
        "documind:user:read" | "user.read" => Some("user.read".to_string()),
        "documind:user:write" | "user.write" => Some("user.write".to_string()),
        _ => None,
    }
}

fn intersect_permissions(local: &[String], portal: &[String]) -> Vec<String> {
    let mut permissions = local
        .iter()
        .filter(|permission| {
            portal
                .iter()
                .any(|portal_permission| portal_permission == *permission)
        })
        .cloned()
        .collect::<Vec<_>>();
    permissions.sort();
    permissions.dedup();
    permissions
}

fn map_documind_role(role: &str) -> Option<String> {
    match role {
        "super_admin" => Some("super_admin".to_string()),
        "tenant_owner" => Some("tenant_owner".to_string()),
        "tenant_admin" => Some("tenant_admin".to_string()),
        "enterprise_admin" => Some("enterprise_admin".to_string()),
        "team_admin" => Some("team_admin".to_string()),
        "data_admin" => Some("data_admin".to_string()),
        "analyst" => Some("analyst".to_string()),
        "user" => Some("user".to_string()),
        "viewer" => Some("viewer".to_string()),
        "end_user" => Some("user".to_string()),
        _ => None,
    }
}

fn map_portal_role_for_documind(role: &str) -> Option<String> {
    match role {
        "super-admin" | "super_admin" => Some("super_admin".to_string()),
        "tenant-owner" | "tenant_owner" => Some("tenant_owner".to_string()),
        "tenant-admin" | "tenant_admin" => Some("tenant_admin".to_string()),
        "module-admin" | "module_admin" | "subsystem-admin" | "subsystem_admin" => {
            Some("team_admin".to_string())
        }
        "admin" | "enterprise-admin" | "enterprise_admin" => Some("enterprise_admin".to_string()),
        "normal-user" | "normal_user" | "normal" | "user" | "viewer" | "end_user" => {
            Some("user".to_string())
        }
        _ => None,
    }
}

fn sort_documind_roles_by_priority(roles: Vec<String>) -> Vec<String> {
    let priority = [
        "super_admin",
        "tenant_owner",
        "tenant_admin",
        "enterprise_admin",
        "team_admin",
        "data_admin",
        "analyst",
        "user",
        "viewer",
    ];
    priority
        .iter()
        .filter(|role| roles.iter().any(|value| value == **role))
        .map(|role| (*role).to_string())
        .collect()
}

fn portal_success_html(token: &str, actor: &crate::models::CurrentActor) -> Response {
    let auth = json!({
        "token": token,
        "userId": actor.user_id,
        "tenantId": actor.tenant_id,
        "email": actor.email,
        "roles": actor.roles,
    });
    let auth_json = serde_json::to_string(&auth).unwrap_or_else(|_| "{}".to_string());
    let target = default_route_for_roles(&actor.roles);
    let target_json = serde_json::to_string(target).unwrap_or_else(|_| "\"/chat\"".to_string());
    let html = format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>DocuMind 登录中</title></head>
<body>
<script>
const auth = {auth_json};
const prefix = window.location.pathname.startsWith("/documind/") || window.location.pathname === "/documind" ? "/documind" : "";
const target = {target_json};
localStorage.setItem("documind-auth", JSON.stringify(auth));
window.location.replace(`${{prefix}}${{target}}`);
</script>
</body></html>"#
    );
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        html,
    )
        .into_response()
}

fn portal_callback_error(err: AppError) -> Response {
    let (status, message) = match err {
        AppError::NotFound { message, .. } => (StatusCode::NOT_FOUND, message),
        AppError::Forbidden { message, .. } => (StatusCode::FORBIDDEN, message),
        AppError::Conflict { message, .. } => (StatusCode::CONFLICT, message),
        AppError::InvalidState { message, .. } => (StatusCode::CONFLICT, message),
        AppError::Timeout { message, .. } => (StatusCode::GATEWAY_TIMEOUT, message),
        AppError::BadRequest { message, .. } => (StatusCode::BAD_REQUEST, message),
        AppError::Unauthorized { message, .. } => (StatusCode::UNAUTHORIZED, message),
        AppError::Internal(err) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{err}")),
    };
    let html = format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>DocuMind 登录失败</title></head>
<body><p>门户登录失败：{}</p></body></html>"#,
        html_escape(&message)
    );
    (
        status,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        html,
    )
        .into_response()
}

fn portal_error_code(err: &AppError) -> &'static str {
    match err {
        AppError::NotFound { .. } => "not_found",
        AppError::Forbidden { .. } => "forbidden",
        AppError::Conflict { .. } => "conflict",
        AppError::InvalidState { .. } => "invalid_state",
        AppError::Timeout { .. } => "timeout",
        AppError::BadRequest { .. } => "bad_request",
        AppError::Unauthorized { .. } => "unauthorized",
        AppError::Internal(_) => "internal_error",
    }
}

fn default_route_for_roles(roles: &[String]) -> &'static str {
    if roles.iter().any(|r| r == "super_admin") {
        "/system"
    } else if roles.iter().any(|r| {
        matches!(
            r.as_str(),
            "tenant_owner" | "tenant_admin" | "enterprise_admin" | "team_admin" | "data_admin"
        )
    }) {
        "/admin"
    } else if roles.iter().any(|r| r == "viewer") {
        "/knowledge"
    } else {
        "/chat"
    }
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(63).collect()
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_portal_permissions_to_local_names() {
        let permissions = map_portal_permissions(&[
            "documind:chat:ask".to_string(),
            "documind:knowledge:manage".to_string(),
            "documind:document:upload".to_string(),
            "unknown".to_string(),
        ]);
        assert_eq!(
            permissions,
            vec![
                "chat.ask".to_string(),
                "document.upload".to_string(),
                "kb.manage".to_string()
            ]
        );
    }

    #[test]
    fn clamps_local_permissions_to_portal_upper_bound() {
        let local = vec![
            "chat.ask".to_string(),
            "document.upload".to_string(),
            "kb.manage".to_string(),
        ];
        let portal = vec!["chat.ask".to_string(), "kb.manage".to_string()];
        assert_eq!(
            intersect_permissions(&local, &portal),
            vec!["chat.ask".to_string(), "kb.manage".to_string()]
        );
    }
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
        match auth::authenticate(&state, username, &req.password, tenant_key).await {
            Ok(value) => value,
            Err(err) => {
                let _ = auth::record_audit_event(
                    &state,
                    None,
                    "auth.login_failed",
                    Some("auth_session"),
                    None,
                    json!({
                        "username": username,
                        "tenant": tenant_key,
                    }),
                )
                .await;
                return Err(err);
            }
        };
    auth::record_audit_event(
        &state,
        Some(&actor),
        "auth.login_succeeded",
        Some("auth_session"),
        None,
        json!({
            "email": actor.email.clone(),
            "roles": actor.roles.clone(),
        }),
    )
    .await?;
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
        if let Ok(actor) = auth::actor_from_claims(&state, &claims).await {
            let _ = auth::record_audit_event(
                &state,
                Some(&actor),
                "auth.logout",
                Some("auth_session"),
                claims.sid.as_deref(),
                json!({}),
            )
            .await;
        }
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
