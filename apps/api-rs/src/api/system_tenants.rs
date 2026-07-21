use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_super_admin, ActorExtractor};
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateTenantRequest {
    name: String,
    slug: Option<String>,
    plan: Option<String>,
    admin_email: String,
    admin_name: Option<String>,
    expires_in_days: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTenantRequest {
    name: Option<String>,
    plan: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteTenantQuery {
    confirm_slug: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreatedTenant {
    id: Uuid,
    name: String,
    slug: String,
    plan: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct CreatedInvitation {
    id: Uuid,
    email: String,
    roles: Vec<String>,
    status: String,
    expires_at: chrono::DateTime<Utc>,
    invite_url: String,
}

#[derive(Debug, Serialize)]
pub struct CreateTenantResponse {
    tenant: CreatedTenant,
    invitation: CreatedInvitation,
}

pub async fn create_tenant(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(req): Json<CreateTenantRequest>,
) -> Result<Json<CreateTenantResponse>, AppError> {
    require_super_admin(&actor)?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "租户管理功能需要数据库"))?;
    let name = normalize_name(&req.name)?;
    let slug = normalize_slug(req.slug.as_deref().unwrap_or(&name))?;
    let plan = normalize_plan(req.plan.as_deref())?;
    let email = normalize_email(&req.admin_email)?;
    let admin_name = req
        .admin_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let expires_at = Utc::now() + Duration::days(req.expires_in_days.unwrap_or(7).clamp(1, 30));

    let slug_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tenant WHERE lower(slug) = lower($1))")
            .bind(&slug)
            .fetch_one(pool)
            .await?;
    if slug_exists {
        return Err(AppError::Conflict {
            code: "TENANT_SLUG_EXISTS".to_string(),
            message: "租户标识已存在".to_string(),
        });
    }

    let tenant_id = Uuid::new_v4();
    let invitation_id = Uuid::new_v4();
    let token = new_invitation_token();
    let token_hash = invitation_token_hash(&token);
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO tenant (id, name, slug, plan, status)
        VALUES ($1, $2, $3, $4, 'pending')
        "#,
    )
    .bind(tenant_id)
    .bind(&name)
    .bind(&slug)
    .bind(&plan)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO tenant_invitation
          (id, tenant_id, email, name, roles, kb_grants, token_hash, status, invited_by, expires_at)
        VALUES ($1, $2, $3, $4, ARRAY['tenant_admin'], '[]'::jsonb, $5, 'pending', $6, $7)
        "#,
    )
    .bind(invitation_id)
    .bind(tenant_id)
    .bind(&email)
    .bind(admin_name)
    .bind(&token_hash)
    .bind(actor.user_id)
    .bind(expires_at)
    .execute(&mut *transaction)
    .await?;
    insert_system_audit(
        &mut transaction,
        tenant_id,
        actor.user_id,
        "tenant.create",
        "tenant",
        tenant_id,
        json!({
            "name": name,
            "slug": slug,
            "plan": plan,
            "initial_admin_email": email,
            "invitation_id": invitation_id,
            "expires_at": expires_at,
        }),
    )
    .await?;
    transaction.commit().await?;

    Ok(Json(CreateTenantResponse {
        tenant: CreatedTenant {
            id: tenant_id,
            name,
            slug,
            plan,
            status: "pending".to_string(),
        },
        invitation: CreatedInvitation {
            id: invitation_id,
            email,
            roles: vec!["tenant_admin".to_string()],
            status: "pending".to_string(),
            expires_at,
            invite_url: format!("/invite?token={token}"),
        },
    }))
}

pub async fn update_tenant(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(tenant_id): Path<Uuid>,
    Json(req): Json<UpdateTenantRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_super_admin(&actor)?;
    if req.name.is_none() && req.plan.is_none() && req.status.is_none() {
        return Err(AppError::bad_request(
            "TENANT_UPDATE_EMPTY",
            "请至少修改一个租户字段",
        ));
    }
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "租户管理功能需要数据库"))?;
    let current = sqlx::query("SELECT name, slug, plan, status FROM tenant WHERE id = $1")
        .bind(tenant_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(tenant_not_found)?;
    let current_status: String = current.get("status");
    let name = req.name.as_deref().map(normalize_name).transpose()?;
    let plan = req
        .plan
        .as_deref()
        .map(|value| normalize_plan(Some(value)))
        .transpose()?;
    let status = req.status.as_deref().map(normalize_status).transpose()?;
    if let Some(next_status) = status.as_deref() {
        ensure_status_transition(&current_status, next_status)?;
    }

    let updated = sqlx::query(
        r#"
        UPDATE tenant
        SET name = COALESCE($2, name),
            plan = COALESCE($3, plan),
            status = COALESCE($4, status),
            suspended_at = CASE WHEN $4 = 'suspended' THEN NOW() WHEN $4 = 'active' THEN NULL ELSE suspended_at END,
            archived_at = CASE WHEN $4 = 'archived' THEN NOW() WHEN $4 = 'active' THEN NULL ELSE archived_at END,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, slug, plan, status, updated_at
        "#,
    )
    .bind(tenant_id)
    .bind(name.as_deref())
    .bind(plan.as_deref())
    .bind(status.as_deref())
    .fetch_one(pool)
    .await?;
    insert_system_audit_direct(
        pool,
        tenant_id,
        actor.user_id,
        "tenant.update",
        json!({
            "previous_status": current_status,
            "name": updated.get::<String, _>("name"),
            "plan": updated.get::<String, _>("plan"),
            "status": updated.get::<String, _>("status"),
        }),
    )
    .await?;
    Ok(Json(json!({
        "id": updated.get::<Uuid, _>("id"),
        "name": updated.get::<String, _>("name"),
        "slug": updated.get::<String, _>("slug"),
        "plan": updated.get::<String, _>("plan"),
        "status": updated.get::<String, _>("status"),
        "updated_at": updated.get::<chrono::DateTime<Utc>, _>("updated_at"),
    })))
}

pub async fn request_tenant_deletion(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(tenant_id): Path<Uuid>,
    Query(query): Query<DeleteTenantQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_super_admin(&actor)?;
    if tenant_id == actor.tenant_id {
        return Err(AppError::Conflict {
            code: "CURRENT_TENANT_DELETE_FORBIDDEN".to_string(),
            message: "不能删除当前平台管理员的兼容登录租户".to_string(),
        });
    }
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "租户管理功能需要数据库"))?;
    let row = sqlx::query("SELECT slug, status FROM tenant WHERE id = $1")
        .bind(tenant_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(tenant_not_found)?;
    let slug: String = row.get("slug");
    if query.confirm_slug.as_deref() != Some(slug.as_str()) {
        return Err(AppError::bad_request(
            "TENANT_DELETE_CONFIRMATION_MISMATCH",
            "请输入正确的租户 slug 以确认删除",
        ));
    }

    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE tenant
        SET status = 'deletion_pending',
            deletion_requested_at = NOW(),
            deletion_requested_by = $2,
            updated_at = NOW()
        WHERE id = $1
        "#,
    )
    .bind(tenant_id)
    .bind(actor.user_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"
        UPDATE tenant_invitation
        SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1 AND status = 'pending'
        "#,
    )
    .bind(tenant_id)
    .execute(&mut *transaction)
    .await?;
    insert_system_audit(
        &mut transaction,
        tenant_id,
        actor.user_id,
        "tenant.deletion_requested",
        "tenant",
        tenant_id,
        json!({ "slug": slug, "previous_status": row.get::<String, _>("status") }),
    )
    .await?;
    transaction.commit().await?;

    Ok(Json(json!({
        "id": tenant_id,
        "slug": slug,
        "status": "deletion_pending",
        "recoverable": true
    })))
}

fn normalize_name(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 128 {
        return Err(AppError::bad_request(
            "TENANT_NAME_INVALID",
            "租户名称不能为空且不能超过 128 个字符",
        ));
    }
    Ok(value.to_string())
}

fn normalize_slug(value: &str) -> Result<String, AppError> {
    let mut slug = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').chars().take(63).collect::<String>();
    if slug.len() < 2 {
        return Err(AppError::bad_request(
            "TENANT_SLUG_INVALID",
            "租户标识至少需要 2 个字母、数字或连字符",
        ));
    }
    Ok(slug)
}

fn normalize_email(value: &str) -> Result<String, AppError> {
    let email = value.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') || email.chars().count() > 128 {
        return Err(AppError::bad_request("EMAIL_INVALID", "请输入有效邮箱"));
    }
    Ok(email)
}

fn normalize_plan(value: Option<&str>) -> Result<String, AppError> {
    match value.unwrap_or("enterprise").trim() {
        "trial" => Ok("trial".to_string()),
        "team" => Ok("team".to_string()),
        "enterprise" => Ok("enterprise".to_string()),
        _ => Err(AppError::bad_request(
            "TENANT_PLAN_INVALID",
            "租户套餐只能是 trial、team 或 enterprise",
        )),
    }
}

fn normalize_status(value: &str) -> Result<String, AppError> {
    match value.trim() {
        "pending" | "active" | "suspended" | "archived" | "deletion_pending" => {
            Ok(value.trim().to_string())
        }
        _ => Err(AppError::bad_request(
            "TENANT_STATUS_INVALID",
            "租户状态无效",
        )),
    }
}

fn ensure_status_transition(current: &str, next: &str) -> Result<(), AppError> {
    let allowed = current == next
        || matches!(
            (current, next),
            ("pending", "active")
                | ("pending", "suspended")
                | ("pending", "archived")
                | ("active", "suspended")
                | ("active", "archived")
                | ("suspended", "active")
                | ("suspended", "archived")
                | ("archived", "active")
        );
    if allowed {
        Ok(())
    } else {
        Err(AppError::Conflict {
            code: "TENANT_STATUS_TRANSITION_INVALID".to_string(),
            message: format!("租户状态不能从 {current} 变更为 {next}"),
        })
    }
}

fn new_invitation_token() -> String {
    format!("inv_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn invitation_token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

async fn insert_system_audit(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: Uuid,
    actor_user_id: Uuid,
    action: &str,
    resource_type: &str,
    resource_id: Uuid,
    detail: serde_json::Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO audit_log
          (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
        VALUES ($1, $2, 'super_admin', $3, $4, $5, $6)
        "#,
    )
    .bind(tenant_id)
    .bind(actor_user_id)
    .bind(action)
    .bind(resource_type)
    .bind(resource_id.to_string())
    .bind(detail)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn insert_system_audit_direct(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    actor_user_id: Uuid,
    action: &str,
    detail: serde_json::Value,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO audit_log
          (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
        VALUES ($1, $2, 'super_admin', $3, 'tenant', $4, $5)
        "#,
    )
    .bind(tenant_id)
    .bind(actor_user_id)
    .bind(action)
    .bind(tenant_id.to_string())
    .bind(detail)
    .execute(pool)
    .await?;
    Ok(())
}

fn tenant_not_found() -> AppError {
    AppError::NotFound {
        code: "TENANT_NOT_FOUND".to_string(),
        message: "租户不存在".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_tenant_slug() {
        assert_eq!(
            normalize_slug(" Northwind Research ").unwrap(),
            "northwind-research"
        );
        assert!(normalize_slug("中").is_err());
    }

    #[test]
    fn protects_terminal_deletion_state() {
        assert!(ensure_status_transition("active", "suspended").is_ok());
        assert!(ensure_status_transition("deletion_pending", "active").is_err());
    }
}
