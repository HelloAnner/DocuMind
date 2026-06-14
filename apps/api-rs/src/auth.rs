use std::convert::Infallible;

use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::Uuid;

use crate::models::CurrentActor;
use crate::state::AppState;

pub struct ActorExtractor(pub CurrentActor);

#[async_trait]
impl FromRequestParts<AppState> for ActorExtractor {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let cfg = &state.config;
        let headers = &parts.headers;

        // 1. Determine tenant / user / requested role from headers or config.
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

        // 2. Try to enrich from DB.
        let actor = if let Some(pool) = &state.db_pool {
            resolve_actor_from_db(pool, tenant_id, user_id, &requested_role).await
        } else {
            None
        };

        let actor = actor.unwrap_or_else(|| build_actor_from_fallback(tenant_id, user_id, &requested_role, cfg.default_kb_ids.clone()));

        Ok(ActorExtractor(actor))
    }
}

async fn resolve_actor_from_db(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
    requested_role: &str,
) -> Option<CurrentActor> {
    let user: (Uuid, String, Option<String>, String) = sqlx::query_as(
        "SELECT id, email, name, status FROM app_user WHERE id = $1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;

    let member_roles: Vec<String> = sqlx::query_scalar(
        "SELECT UNNEST(roles) FROM tenant_member WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'"
    )
    .bind(tenant_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    let roles = if member_roles.is_empty() {
        vec![requested_role.to_string()]
    } else {
        member_roles
    };

    let is_super_admin = roles.iter().any(|r| r == "super_admin");
    let is_tenant_admin = roles.iter().any(|r| r == "tenant_admin" || r == "tenant_owner");

    let allowed_kb_ids: Vec<Uuid> = if is_super_admin || is_tenant_admin {
        sqlx::query_scalar("SELECT id FROM knowledge_base WHERE tenant_id = $1 AND status = 'active'")
            .bind(tenant_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default()
    } else {
        let query =
            "SELECT DISTINCT kb_id FROM knowledge_base_acl WHERE tenant_id = $1 AND subject_type = 'role' AND subject_id = ANY($2) AND permission = 'read' UNION SELECT DISTINCT kb_id FROM knowledge_base_acl WHERE tenant_id = $1 AND subject_type = 'user' AND subject_id = $3 AND permission = 'read'";
        sqlx::query_scalar(query)
            .bind(tenant_id)
            .bind(&roles)
            .bind(user_id.to_string())
            .fetch_all(pool)
            .await
            .unwrap_or_default()
    };

    let email = user.1;
    Some(CurrentActor {
        user_id,
        tenant_id,
        name: user.2.unwrap_or_else(|| email.clone()),
        email,
        roles: roles.clone(),
        permissions: derive_permissions(&roles),
        allowed_kb_ids,
        is_super_admin,
    })
}

fn build_actor_from_fallback(tenant_id: Uuid, user_id: Uuid, role: &str, default_kb_ids: Vec<Uuid>) -> CurrentActor {
    let roles = vec![role.to_string()];
    let is_super_admin = role == "super_admin";
    CurrentActor {
        user_id,
        tenant_id,
        email: format!("{}@documind.local", role),
        name: role.to_string(),
        roles: roles.clone(),
        permissions: derive_permissions(&roles),
        allowed_kb_ids: default_kb_ids,
        is_super_admin,
    }
}

fn derive_permissions(roles: &[String]) -> Vec<String> {
    let mut perms = vec![];
    for role in roles {
        match role.as_str() {
            "super_admin" => {
                perms.extend([
                    "tenant.read", "tenant.write", "tenant.delete",
                    "user.read", "user.write", "user.delete",
                    "model.read", "model.write", "model.delete",
                    "job.read", "job.write",
                    "audit.read",
                    "kb.read", "kb.write", "kb.manage",
                    "document.upload", "document.delete", "document.reprocess",
                    "config.read", "config.write",
                    "member.read", "member.write", "member.delete",
                    "chat.ask", "answer.feedback",
                ].map(String::from));
            }
            "tenant_owner" | "tenant_admin" => {
                perms.extend([
                    "kb.read", "kb.write", "kb.manage",
                    "document.upload", "document.delete", "document.reprocess",
                    "config.read", "config.write",
                    "member.read", "member.write", "member.delete",
                    "audit.read",
                    "chat.ask", "answer.feedback",
                ].map(String::from));
            }
            "end_user" => {
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

pub fn require_super_admin(actor: &CurrentActor) -> Result<(), crate::error::AppError> {
    if actor.is_super_admin {
        Ok(())
    } else {
        Err(crate::error::AppError::forbidden())
    }
}

pub fn require_tenant_admin(actor: &CurrentActor) -> Result<(), crate::error::AppError> {
    if actor.is_super_admin || actor.roles.iter().any(|r| r == "tenant_admin" || r == "tenant_owner") {
        Ok(())
    } else {
        Err(crate::error::AppError::forbidden())
    }
}

pub fn require_permission(actor: &CurrentActor, permission: &str) -> Result<(), crate::error::AppError> {
    if actor.has_permission(permission) {
        Ok(())
    } else {
        Err(crate::error::AppError::forbidden())
    }
}

pub fn require_kb_permission(
    actor: &CurrentActor,
    kb_id: Uuid,
    _permission: &str,
) -> Result<(), crate::error::AppError> {
    if actor.is_super_admin || actor.allowed_kb_ids.contains(&kb_id) {
        Ok(())
    } else {
        Err(crate::error::AppError::kb_scope_denied())
    }
}
