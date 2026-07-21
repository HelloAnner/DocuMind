use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::{header, request::Parts};
use bcrypt::{hash, verify, DEFAULT_COST};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::models::CurrentActor;
use crate::state::AppState;

pub struct ActorExtractor(pub CurrentActor);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub email: String,
    pub role: String,
    pub tenant_id: Uuid,
    pub sid: Option<String>,
    pub exp: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthSession {
    user_id: Uuid,
    tenant_id: Uuid,
    role: String,
    created_at: i64,
    last_seen_at: i64,
}

#[async_trait]
impl FromRequestParts<AppState> for ActorExtractor {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let cfg = &state.config;
        let headers = &parts.headers;

        // 1. Prefer JWT Bearer authentication when an Authorization header is present.
        if let Some(actor) = actor_from_bearer_token(state, headers).await? {
            return Ok(ActorExtractor(actor));
        }

        // 2. In a database-backed deployment, API requests must use the local
        // JWT/session identity. The header fallback is kept only for no-DB
        // development mode.
        if state.db_pool.is_some() {
            return Err(AppError::unauthorized());
        }

        // 3. Fall back to trusted upstream headers in no-DB development mode.
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
        let requested_role = headers
            .get("x-role")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string())
            .unwrap_or_else(|| cfg.default_role.clone());

        let actor = if let Some(pool) = &state.db_pool {
            resolve_actor_from_db(pool, tenant_id, user_id, &requested_role)
                .await
                .ok()
        } else {
            None
        };

        let actor = actor.unwrap_or_else(|| {
            build_actor_from_fallback(
                tenant_id,
                user_id,
                &requested_role,
                &requested_role,
                &requested_role,
                cfg.default_kb_ids.clone(),
            )
        });

        Ok(ActorExtractor(actor))
    }
}

pub async fn actor_from_bearer_token(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<Option<CurrentActor>, AppError> {
    let Ok(claims) = claims_from_headers(&state.config, headers) else {
        return Ok(None);
    };
    if claims.sid.is_some() {
        validate_and_renew_auth_session(state, &claims).await?;
    }
    actor_from_claims(state, &claims).await.map(Some)
}

pub fn claims_from_headers(
    config: &AppConfig,
    headers: &axum::http::HeaderMap,
) -> Result<Claims, AppError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(AppError::unauthorized)?;
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::unauthorized())
}

pub async fn authenticate(
    state: &AppState,
    username: &str,
    password: &str,
    tenant_key: Option<&str>,
) -> Result<(CurrentActor, String), AppError> {
    if username.trim().is_empty() || password.is_empty() {
        return Err(AppError::bad_request(
            "CREDENTIALS_REQUIRED",
            "请输入用户名和密码",
        ));
    }

    let actor = if let Some(pool) = &state.db_pool {
        authenticate_from_db(pool, username.trim(), password, tenant_key).await?
    } else {
        authenticate_from_config(&state.config, username.trim(), password)?
    };

    let session_id = create_auth_session(state, &actor).await?;
    let token = issue_token(&state.config, &actor, Some(&session_id))?;
    Ok((actor, token))
}

async fn authenticate_from_db(
    pool: &PgPool,
    username: &str,
    password: &str,
    tenant_key: Option<&str>,
) -> Result<CurrentActor, AppError> {
    let user = sqlx::query(
        "SELECT id, email, name, password_hash, status FROM app_user WHERE lower(email) = lower($1) LIMIT 1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?
    .ok_or_else(AppError::unauthorized)?;

    let status: String = user.get("status");
    if status != "active" {
        return Err(AppError::unauthorized());
    }
    let password_hash: Option<String> = user.try_get("password_hash").ok();
    let Some(password_hash) = password_hash.filter(|v| !v.is_empty()) else {
        return Err(AppError::unauthorized());
    };
    let ok = verify(password, &password_hash).unwrap_or(false);
    if !ok {
        return Err(AppError::unauthorized());
    }

    let user_id: Uuid = user.get("id");
    let membership = if let Some(tenant_key) = tenant_key.filter(|v| !v.trim().is_empty()) {
        sqlx::query(
            r#"
            SELECT tm.tenant_id, tm.roles, tm.attributes, t.name, t.slug, t.plan, t.status
            FROM tenant_member tm
            JOIN tenant t ON t.id = tm.tenant_id
            WHERE tm.user_id = $1
              AND tm.status = 'active'
              AND (
                t.status = 'active'
                OR EXISTS (
                  SELECT 1 FROM platform_admin pa
                  WHERE pa.user_id = tm.user_id AND pa.status = 'active'
                )
              )
              AND (tm.tenant_id::text = $2 OR t.slug = $2)
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .bind(tenant_key)
        .fetch_optional(pool)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT tm.tenant_id, tm.roles, tm.attributes, t.name, t.slug, t.plan, t.status
            FROM tenant_member tm
            JOIN tenant t ON t.id = tm.tenant_id
            WHERE tm.user_id = $1
              AND tm.status = 'active'
              AND (
                t.status = 'active'
                OR EXISTS (
                  SELECT 1 FROM platform_admin pa
                  WHERE pa.user_id = tm.user_id AND pa.status = 'active'
                )
              )
            ORDER BY
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM platform_admin pa
                  WHERE pa.user_id = tm.user_id AND pa.status = 'active'
                ) THEN 0
                WHEN tm.tenant_id = (
                  SELECT last_active_tenant FROM app_user WHERE id = tm.user_id
                ) THEN 1
                WHEN 'tenant_admin' = ANY(tm.roles) THEN 2
                ELSE 3
              END,
              tm.joined_at DESC NULLS LAST
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?
    }
    .ok_or_else(AppError::unauthorized)?;

    let tenant_id: Uuid = membership.get("tenant_id");
    let membership_roles: Vec<String> = membership.get("roles");
    let is_super_admin = platform_admin_active(pool, user_id).await?;
    let roles = normalized_actor_roles(&membership_roles, is_super_admin);
    let attributes: serde_json::Value = membership
        .try_get("attributes")
        .unwrap_or_else(|_| serde_json::json!({}));
    let allowed_kb_ids = allowed_kb_ids(pool, tenant_id, user_id, &roles).await?;
    let permissions = effective_permissions_for_membership(&roles, &attributes);
    let email: String = user.get("email");
    let name: Option<String> = user.try_get("name").ok();
    Ok(CurrentActor {
        user_id,
        tenant_id,
        email: email.clone(),
        name: name.unwrap_or(email),
        roles: roles.clone(),
        permissions,
        allowed_kb_ids,
        is_super_admin,
    })
}

fn authenticate_from_config(
    config: &AppConfig,
    username: &str,
    password: &str,
) -> Result<CurrentActor, AppError> {
    let account = [
        (
            config.super_admin_email.as_str(),
            config.super_admin_password.as_str(),
            config.super_admin_user_id,
            "super_admin",
            "Ops Super Admin",
        ),
        (
            config.enterprise_admin_email.as_str(),
            config.enterprise_admin_password.as_str(),
            config.default_user_id,
            "enterprise_admin",
            "Enterprise Admin",
        ),
        (
            config.standard_user_email.as_str(),
            config.standard_user_password.as_str(),
            config.standard_user_id,
            "user",
            "DocuMind User",
        ),
    ]
    .into_iter()
    .find(|(email, expected_password, _, _, _)| {
        email.eq_ignore_ascii_case(username) && password == *expected_password
    })
    .ok_or_else(AppError::unauthorized)?;

    Ok(build_actor_from_fallback(
        config.default_tenant_id,
        account.2,
        account.0,
        account.4,
        account.3,
        config.default_kb_ids.clone(),
    ))
}

pub async fn actor_from_claims(
    state: &AppState,
    claims: &Claims,
) -> Result<CurrentActor, AppError> {
    if let Some(pool) = &state.db_pool {
        resolve_actor_from_db(pool, claims.tenant_id, claims.sub, &claims.role).await
    } else {
        Ok(build_actor_from_fallback(
            claims.tenant_id,
            claims.sub,
            &claims.email,
            &claims.email,
            &claims.role,
            state.config.default_kb_ids.clone(),
        ))
    }
}

async fn resolve_actor_from_db(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
    _requested_role: &str,
) -> Result<CurrentActor, AppError> {
    let user: (Uuid, String, Option<String>, String) =
        sqlx::query_as("SELECT id, email, name, status FROM app_user WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(AppError::unauthorized)?;

    let status: String = user.3;
    if status != "active" {
        return Err(AppError::unauthorized());
    }

    let membership = sqlx::query(
        r#"
        SELECT tm.roles, tm.attributes
        FROM tenant_member tm
        JOIN tenant t ON t.id = tm.tenant_id
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
          AND tm.status = 'active'
          AND (
            t.status = 'active'
            OR EXISTS (
              SELECT 1 FROM platform_admin pa
              WHERE pa.user_id = tm.user_id AND pa.status = 'active'
            )
          )
        LIMIT 1
        "#,
    )
    .bind(tenant_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(AppError::unauthorized)?;
    let membership_roles: Vec<String> = membership.get("roles");
    let is_super_admin = platform_admin_active(pool, user_id).await?;
    let roles = normalized_actor_roles(&membership_roles, is_super_admin);
    let attributes: serde_json::Value = membership
        .try_get("attributes")
        .unwrap_or_else(|_| serde_json::json!({}));

    if roles.is_empty() {
        return Err(AppError::unauthorized());
    }

    let allowed_kb_ids = allowed_kb_ids(pool, tenant_id, user_id, &roles).await?;
    let permissions = effective_permissions_for_membership(&roles, &attributes);
    let email = user.1;
    let name = user.2;
    Ok(CurrentActor {
        user_id,
        tenant_id,
        name: name.unwrap_or_else(|| email.clone()),
        email,
        roles: roles.clone(),
        permissions,
        allowed_kb_ids,
        is_super_admin,
    })
}

async fn platform_admin_active(pool: &PgPool, user_id: Uuid) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM platform_admin WHERE user_id = $1 AND status = 'active')",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?)
}

fn normalized_actor_roles(membership_roles: &[String], is_super_admin: bool) -> Vec<String> {
    let mut roles = membership_roles
        .iter()
        .filter_map(|role| match role.as_str() {
            "super_admin" => None,
            "enterprise_admin" | "team_admin" | "data_admin" | "tenant_owner" | "tenant_admin" => {
                Some("tenant_admin".to_string())
            }
            "user" | "analyst" | "viewer" | "end_user" => Some("end_user".to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    roles.sort();
    roles.dedup();
    if is_super_admin {
        roles.insert(0, "super_admin".to_string());
    }
    roles
}

fn effective_permissions_for_membership(
    roles: &[String],
    attributes: &serde_json::Value,
) -> Vec<String> {
    let local = derive_permissions(roles);
    let Some(effective) = attributes
        .get("effective_permissions")
        .and_then(|value| value.as_array())
    else {
        return local;
    };

    let mut clamped = effective
        .iter()
        .filter_map(|value| value.as_str())
        .filter(|permission| {
            local
                .iter()
                .any(|local_permission| local_permission == permission)
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    clamped.sort();
    clamped.dedup();
    clamped
}

async fn allowed_kb_ids(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
    roles: &[String],
) -> Result<Vec<Uuid>, AppError> {
    if is_documind_admin(roles) {
        return Ok(sqlx::query_scalar(
            "SELECT id FROM knowledge_base WHERE tenant_id = $1 AND status = 'active'",
        )
        .bind(tenant_id)
        .fetch_all(pool)
        .await?);
    }

    let ids = sqlx::query_scalar(
        r#"
        SELECT DISTINCT kb_id
        FROM knowledge_base_acl
        WHERE tenant_id = $1
          AND permission IN ('read', 'write', 'manage')
          AND (
            (subject_type = 'role' AND subject_id = ANY($2))
            OR (subject_type = 'user' AND subject_id = $3)
          )
        "#,
    )
    .bind(tenant_id)
    .bind(roles)
    .bind(user_id.to_string())
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

fn build_actor_from_fallback(
    tenant_id: Uuid,
    user_id: Uuid,
    email: &str,
    name: &str,
    role: &str,
    default_kb_ids: Vec<Uuid>,
) -> CurrentActor {
    let is_super_admin = role == "super_admin";
    let roles = normalized_actor_roles(&[role.to_string()], is_super_admin);
    CurrentActor {
        user_id,
        tenant_id,
        email: email.to_string(),
        name: name.to_string(),
        roles: roles.clone(),
        permissions: derive_permissions(&roles),
        allowed_kb_ids: if is_super_admin {
            Vec::new()
        } else {
            default_kb_ids
        },
        is_super_admin,
    }
}

pub fn issue_token(
    config: &AppConfig,
    actor: &CurrentActor,
    session_id: Option<&str>,
) -> Result<String, AppError> {
    let exp = Utc::now() + Duration::hours(config.auth_token_expire_hours.max(1));
    let role = actor
        .roles
        .first()
        .cloned()
        .unwrap_or_else(|| "user".to_string());
    let claims = Claims {
        sub: actor.user_id,
        email: actor.email.clone(),
        role,
        tenant_id: actor.tenant_id,
        sid: session_id.map(str::to_string),
        exp: exp.timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(e.into()))
}

fn auth_session_key(session_id: &str) -> String {
    format!("documind:auth:session:{session_id}")
}

pub async fn create_auth_session(
    state: &AppState,
    actor: &CurrentActor,
) -> Result<String, AppError> {
    let session_id = Uuid::new_v4().to_string();
    let Some(redis) = state.redis_client.as_ref() else {
        return Ok(session_id);
    };
    let now = Utc::now().timestamp();
    let session = AuthSession {
        user_id: actor.user_id,
        tenant_id: actor.tenant_id,
        role: actor
            .roles
            .first()
            .cloned()
            .unwrap_or_else(|| "user".to_string()),
        created_at: now,
        last_seen_at: now,
    };
    let payload = serde_json::to_string(&session).map_err(|e| AppError::Internal(e.into()))?;
    let mut conn = redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let _: () = conn
        .set_ex(
            auth_session_key(&session_id),
            payload,
            (state.config.auth_token_expire_hours.max(1) * 60 * 60) as u64,
        )
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(session_id)
}

pub async fn validate_and_renew_auth_session(
    state: &AppState,
    claims: &Claims,
) -> Result<(), AppError> {
    let Some(redis) = state.redis_client.as_ref() else {
        return Ok(());
    };
    let session_id = claims.sid.as_deref().ok_or_else(AppError::unauthorized)?;
    let mut conn = redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let raw: Option<String> = conn
        .get(auth_session_key(session_id))
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let Some(raw) = raw else {
        return Err(AppError::unauthorized());
    };
    let mut session: AuthSession =
        serde_json::from_str(&raw).map_err(|e| AppError::Internal(e.into()))?;
    if session.user_id != claims.sub || session.tenant_id != claims.tenant_id {
        return Err(AppError::unauthorized());
    }
    session.last_seen_at = Utc::now().timestamp();
    let payload = serde_json::to_string(&session).map_err(|e| AppError::Internal(e.into()))?;
    let _: () = conn
        .set_ex(
            auth_session_key(session_id),
            payload,
            (state.config.auth_token_expire_hours.max(1) * 60 * 60) as u64,
        )
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(())
}

pub async fn delete_auth_session(state: &AppState, session_id: &str) -> Result<(), AppError> {
    let Some(redis) = state.redis_client.as_ref() else {
        return Ok(());
    };
    let mut conn = redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let _: () = conn
        .del(auth_session_key(session_id))
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(())
}

pub fn derive_permissions(roles: &[String]) -> Vec<String> {
    let mut perms = vec![];
    for role in roles {
        match normalize_role(role).as_str() {
            "super_admin" => {
                perms.extend(
                    [
                        "tenant.read",
                        "tenant.write",
                        "tenant.delete",
                        "user.read",
                        "user.write",
                        "user.delete",
                        "model.read",
                        "model.write",
                        "model.delete",
                        "job.read",
                        "job.write",
                        "audit.read",
                    ]
                    .map(String::from),
                );
            }
            "enterprise_admin" | "tenant_owner" | "tenant_admin" => {
                perms.extend(
                    [
                        "tenant.read",
                        "tenant.write",
                        "user.read",
                        "user.write",
                        "kb.read",
                        "kb.create",
                        "kb.write",
                        "kb.manage",
                        "document.upload",
                        "document.delete",
                        "document.reprocess",
                        "config.read",
                        "config.write",
                        "member.read",
                        "member.write",
                        "member.delete",
                        "audit.read",
                        "chat.ask",
                        "answer.feedback",
                    ]
                    .map(String::from),
                );
            }
            "team_admin" | "data_admin" => {
                perms.extend(
                    [
                        "kb.read",
                        "kb.write",
                        "document.upload",
                        "document.reprocess",
                        "member.read",
                        "audit.read",
                        "chat.ask",
                        "answer.feedback",
                    ]
                    .map(String::from),
                );
            }
            "user" | "analyst" | "end_user" => {
                perms.extend(["kb.read", "chat.ask", "answer.feedback"].map(String::from));
            }
            "viewer" => {
                perms.push("kb.read".to_string());
            }
            _ => {}
        }
    }
    perms.sort();
    perms.dedup();
    perms
}

pub fn role_matrix() -> serde_json::Value {
    let roles = [
        "super_admin",
        "enterprise_admin",
        "team_admin",
        "data_admin",
        "user",
        "viewer",
        "tenant_owner",
        "tenant_admin",
        "end_user",
    ];
    let mut map = serde_json::Map::new();
    for role in roles {
        map.insert(
            role.to_string(),
            serde_json::json!(derive_permissions(&[role.to_string()])),
        );
    }
    serde_json::Value::Object(map)
}

fn normalize_role(role: &str) -> String {
    match role {
        "enterprise_admin" | "team_admin" | "data_admin" | "tenant_owner" => {
            "tenant_admin".to_string()
        }
        "user" | "analyst" | "viewer" => "end_user".to_string(),
        other => other.to_string(),
    }
}

fn is_documind_admin(roles: &[String]) -> bool {
    roles.iter().any(|r| {
        matches!(
            r.as_str(),
            "enterprise_admin" | "tenant_owner" | "tenant_admin" | "team_admin" | "data_admin"
        )
    })
}

pub fn require_super_admin(actor: &CurrentActor) -> Result<(), AppError> {
    if actor.is_super_admin {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

pub fn require_tenant_admin(actor: &CurrentActor) -> Result<(), AppError> {
    if !actor.is_super_admin && is_documind_admin(&actor.roles) {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

pub fn require_permission(actor: &CurrentActor, permission: &str) -> Result<(), AppError> {
    if actor.has_permission(permission) {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

pub fn require_kb_permission(
    actor: &CurrentActor,
    kb_id: Uuid,
    permission: &str,
) -> Result<(), AppError> {
    let required_permission = match permission {
        "read" => "kb.read",
        "write" => "kb.write",
        "manage" => "kb.manage",
        other => other,
    };
    if !actor.has_permission(required_permission) {
        return Err(AppError::forbidden());
    }
    if actor.allowed_kb_ids.contains(&kb_id) {
        Ok(())
    } else {
        Err(AppError::kb_scope_denied())
    }
}

pub async fn record_audit_event(
    state: &AppState,
    actor: Option<&CurrentActor>,
    action: &str,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
    detail: Value,
) -> Result<(), AppError> {
    let Some(pool) = &state.db_pool else {
        return Ok(());
    };
    let tenant_id = actor.map(|a| a.tenant_id);
    let actor_user_id = actor.map(|a| a.user_id);
    let actor_role = actor
        .and_then(|a| a.roles.first().cloned())
        .unwrap_or_else(|| "anonymous".to_string());

    sqlx::query(
        "INSERT INTO audit_log (
            tenant_id, actor_user_id, actor_role, action, resource_type,
            resource_id, detail
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(tenant_id)
    .bind(actor_user_id)
    .bind(actor_role)
    .bind(action)
    .bind(resource_type)
    .bind(resource_id)
    .bind(detail)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn seed_identity(pool: &PgPool, config: &AppConfig) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO tenant (id, name, slug, plan, status)
        VALUES ($1, $2, $3, 'enterprise', 'active')
        ON CONFLICT (id)
        DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = NOW()
        "#,
    )
    .bind(config.default_tenant_id)
    .bind(&config.default_tenant_name)
    .bind(&config.default_tenant_slug)
    .execute(pool)
    .await?;

    upsert_seed_user(
        pool,
        config.default_user_id,
        &config.enterprise_admin_email,
        "DocuMind Enterprise Admin",
        &config.enterprise_admin_password,
    )
    .await?;

    upsert_seed_user(
        pool,
        config.super_admin_user_id,
        &config.super_admin_email,
        "Anner",
        &config.super_admin_password,
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO platform_admin (user_id, role, status)
        VALUES ($1, 'super_admin', 'active')
        ON CONFLICT (user_id)
        DO UPDATE SET role = 'super_admin', status = 'active', updated_at = NOW()
        "#,
    )
    .bind(config.super_admin_user_id)
    .execute(pool)
    .await?;
    upsert_seed_user(
        pool,
        config.standard_user_id,
        &config.standard_user_email,
        "DocuMind User",
        &config.standard_user_password,
    )
    .await?;

    upsert_membership(
        pool,
        config.default_tenant_id,
        config.default_user_id,
        &["tenant_admin"],
    )
    .await?;
    upsert_membership(
        pool,
        config.default_tenant_id,
        config.super_admin_user_id,
        &["super_admin"],
    )
    .await?;
    upsert_membership(
        pool,
        config.default_tenant_id,
        config.standard_user_id,
        &["end_user"],
    )
    .await?;

    let product_kb_id = config
        .default_kb_ids
        .first()
        .copied()
        .unwrap_or_else(|| Uuid::parse_str("00000000-0000-0000-0000-000000000010").unwrap());
    sqlx::query(
        r#"
        INSERT INTO knowledge_base (id, tenant_id, name, description, status, tags)
        VALUES ($1, $2, '产品文档库', '面向全公司的产品手册与白皮书集合', 'active', ARRAY['产品'])
        ON CONFLICT (id)
        DO UPDATE SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, status = EXCLUDED.status, updated_at = NOW()
        "#,
    )
    .bind(product_kb_id)
    .bind(config.default_tenant_id)
    .execute(pool)
    .await?;

    for role in ["tenant_admin"] {
        upsert_acl(
            pool,
            config.default_tenant_id,
            product_kb_id,
            role,
            "manage",
        )
        .await?;
    }
    for role in ["end_user"] {
        upsert_acl(pool, config.default_tenant_id, product_kb_id, role, "read").await?;
    }
    Ok(())
}

async fn upsert_seed_user(
    pool: &PgPool,
    id: Uuid,
    email: &str,
    name: &str,
    password: &str,
) -> anyhow::Result<()> {
    let password_hash = hash(password, DEFAULT_COST)?;
    sqlx::query(
        r#"
        INSERT INTO app_user (id, email, name, password_hash, status)
        VALUES ($1, $2, $3, $4, 'active')
        ON CONFLICT (id)
        DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, status = 'active', updated_at = NOW()
        "#,
    )
    .bind(id)
    .bind(email)
    .bind(name)
    .bind(password_hash)
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_membership(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
    roles: &[&str],
) -> anyhow::Result<()> {
    let roles: Vec<String> = roles.iter().map(|role| role.to_string()).collect();
    sqlx::query(
        r#"
        INSERT INTO tenant_member (tenant_id, user_id, roles, status, joined_at)
        VALUES ($1, $2, $3, 'active', NOW())
        ON CONFLICT (tenant_id, user_id)
        DO UPDATE SET roles = EXCLUDED.roles, status = 'active', updated_at = NOW()
        "#,
    )
    .bind(tenant_id)
    .bind(user_id)
    .bind(roles)
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_acl(
    pool: &PgPool,
    tenant_id: Uuid,
    kb_id: Uuid,
    role: &str,
    permission: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission)
        VALUES ($1, $2, 'role', $3, $4)
        ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING
        "#,
    )
    .bind(tenant_id)
    .bind(kb_id)
    .bind(role)
    .bind(permission)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_admin_has_no_tenant_content_permissions() {
        let permissions = derive_permissions(&["super_admin".to_string()]);
        assert!(permissions.contains(&"tenant.write".to_string()));
        assert!(!permissions.contains(&"kb.read".to_string()));
        assert!(!permissions.contains(&"chat.ask".to_string()));
        assert!(!permissions.contains(&"member.write".to_string()));
    }

    #[test]
    fn tenant_admin_and_end_user_permissions_stay_separate() {
        let admin = derive_permissions(&["tenant_admin".to_string()]);
        let user = derive_permissions(&["end_user".to_string()]);
        assert!(admin.contains(&"document.upload".to_string()));
        assert!(admin.contains(&"member.write".to_string()));
        assert!(user.contains(&"chat.ask".to_string()));
        assert!(!user.contains(&"document.upload".to_string()));
        assert!(!user.contains(&"member.write".to_string()));
    }

    #[test]
    fn legacy_membership_roles_normalize_to_two_tenant_roles() {
        assert_eq!(
            normalized_actor_roles(
                &["enterprise_admin".to_string(), "viewer".to_string()],
                false
            ),
            vec!["end_user".to_string(), "tenant_admin".to_string()]
        );
        assert_eq!(
            normalized_actor_roles(&["super_admin".to_string()], true),
            vec!["super_admin".to_string()]
        );
    }
}
