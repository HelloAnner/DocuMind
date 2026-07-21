use axum::extract::{Path, State};
use axum::routing::patch;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{record_audit_event, require_permission, require_tenant_admin, ActorExtractor};
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct UpdateMemberRequest {
    role: Option<String>,
    status: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/admin/members/:user_id",
        patch(update_member).delete(remove_member),
    )
}

async fn update_member(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(user_id): Path<Uuid>,
    Json(req): Json<UpdateMemberRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "member.write")?;
    if req.role.is_none() && req.status.is_none() {
        return Err(AppError::bad_request(
            "MEMBER_UPDATE_EMPTY",
            "请至少修改角色或状态",
        ));
    }
    let role = req.role.as_deref().map(normalize_member_role).transpose()?;
    let status = req
        .status
        .as_deref()
        .map(normalize_member_status)
        .transpose()?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "成员管理功能需要数据库"))?;
    ensure_not_platform_admin(pool, user_id).await?;

    let current = sqlx::query(
        "SELECT roles, status FROM tenant_member WHERE tenant_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(actor.tenant_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(member_not_found)?;
    let current_roles: Vec<String> = current.get("roles");
    let current_status: String = current.get("status");
    let currently_active_admin =
        current_status == "active" && current_roles.iter().any(|item| item == "tenant_admin");
    let remains_active_admin = status.as_deref().unwrap_or(&current_status) == "active"
        && role.as_deref().unwrap_or_else(|| {
            if current_roles.iter().any(|item| item == "tenant_admin") {
                "tenant_admin"
            } else {
                "end_user"
            }
        }) == "tenant_admin";
    if currently_active_admin && !remains_active_admin {
        ensure_other_active_admin(pool, actor.tenant_id, user_id).await?;
    }

    let updated = sqlx::query(
        r#"
        UPDATE tenant_member
        SET roles = CASE WHEN $3::text IS NULL THEN roles ELSE ARRAY[$3::text] END,
            status = COALESCE($4, status),
            updated_at = NOW()
        WHERE tenant_id = $1 AND user_id = $2
        RETURNING roles, status, joined_at, last_seen_at
        "#,
    )
    .bind(actor.tenant_id)
    .bind(user_id)
    .bind(role.as_deref())
    .bind(status.as_deref())
    .fetch_one(pool)
    .await?;
    let roles: Vec<String> = updated.get("roles");
    let status: String = updated.get("status");

    record_audit_event(
        &state,
        Some(&actor),
        "tenant_member.update",
        Some("tenant_member"),
        Some(&user_id.to_string()),
        json!({ "roles": roles, "status": status }),
    )
    .await?;
    Ok(Json(json!({
        "user_id": user_id,
        "roles": roles,
        "status": status,
        "joined_at": updated.try_get::<chrono::DateTime<chrono::Utc>, _>("joined_at").ok(),
        "last_seen_at": updated.try_get::<chrono::DateTime<chrono::Utc>, _>("last_seen_at").ok()
    })))
}

async fn remove_member(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "member.delete")?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "成员管理功能需要数据库"))?;
    ensure_not_platform_admin(pool, user_id).await?;
    let membership = sqlx::query(
        "SELECT roles, status FROM tenant_member WHERE tenant_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(actor.tenant_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(member_not_found)?;
    let roles: Vec<String> = membership.get("roles");
    let status: String = membership.get("status");
    if status == "active" && roles.iter().any(|item| item == "tenant_admin") {
        ensure_other_active_admin(pool, actor.tenant_id, user_id).await?;
    }

    let mut transaction = pool.begin().await?;
    sqlx::query(
        "UPDATE tenant_member SET status = 'removed', updated_at = NOW() WHERE tenant_id = $1 AND user_id = $2",
    )
    .bind(actor.tenant_id)
    .bind(user_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "DELETE FROM knowledge_base_acl WHERE tenant_id = $1 AND subject_type = 'user' AND subject_id = $2",
    )
    .bind(actor.tenant_id)
    .bind(user_id.to_string())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    record_audit_event(
        &state,
        Some(&actor),
        "tenant_member.remove",
        Some("tenant_member"),
        Some(&user_id.to_string()),
        json!({ "previous_roles": roles }),
    )
    .await?;
    Ok(Json(json!({ "user_id": user_id, "status": "removed" })))
}

fn normalize_member_role(value: &str) -> Result<String, AppError> {
    match value.trim() {
        "tenant_admin" => Ok("tenant_admin".to_string()),
        "end_user" | "user" | "analyst" | "viewer" => Ok("end_user".to_string()),
        "super_admin" => Err(AppError::Forbidden {
            code: "MEMBER_ROLE_FORBIDDEN".to_string(),
            message: "租户管理员不能授予超级管理员角色".to_string(),
        }),
        _ => Err(AppError::bad_request(
            "MEMBER_ROLE_INVALID",
            "成员角色只能是 tenant_admin 或 end_user",
        )),
    }
}

fn normalize_member_status(value: &str) -> Result<String, AppError> {
    match value.trim() {
        "active" | "suspended" => Ok(value.trim().to_string()),
        _ => Err(AppError::bad_request(
            "MEMBER_STATUS_INVALID",
            "成员状态只能是 active 或 suspended",
        )),
    }
}

async fn ensure_not_platform_admin(pool: &sqlx::PgPool, user_id: Uuid) -> Result<(), AppError> {
    let is_platform_admin: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM platform_admin WHERE user_id = $1 AND status = 'active')",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if is_platform_admin {
        return Err(AppError::Forbidden {
            code: "PLATFORM_ADMIN_MEMBER_IMMUTABLE".to_string(),
            message: "平台管理员不能在租户成员页面修改".to_string(),
        });
    }
    Ok(())
}

async fn ensure_other_active_admin(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
) -> Result<(), AppError> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM tenant_member
        WHERE tenant_id = $1
          AND user_id <> $2
          AND status = 'active'
          AND 'tenant_admin' = ANY(roles)
        "#,
    )
    .bind(tenant_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if count == 0 {
        return Err(AppError::Conflict {
            code: "LAST_TENANT_ADMIN".to_string(),
            message: "租户必须至少保留一位启用中的租户管理员".to_string(),
        });
    }
    Ok(())
}

fn member_not_found() -> AppError {
    AppError::NotFound {
        code: "TENANT_MEMBER_NOT_FOUND".to_string(),
        message: "当前租户中不存在该成员".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_legacy_member_roles() {
        assert_eq!(
            normalize_member_role("tenant_admin").unwrap(),
            "tenant_admin"
        );
        assert_eq!(normalize_member_role("user").unwrap(), "end_user");
        assert!(normalize_member_role("super_admin").is_err());
    }
}
