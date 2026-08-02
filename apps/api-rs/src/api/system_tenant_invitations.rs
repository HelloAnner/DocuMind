use axum::extract::{Path, State};
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_super_admin, ActorExtractor};
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct GenerateAdminInvitationRequest {
    email: Option<String>,
    name: Option<String>,
    expires_in_days: Option<i64>,
}

pub async fn generate_admin_invitation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(tenant_id): Path<Uuid>,
    Json(req): Json<GenerateAdminInvitationRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_super_admin(&actor)?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "租户管理功能需要数据库"))?;
    let tenant_status: String = sqlx::query_scalar("SELECT status FROM tenant WHERE id = $1")
        .bind(tenant_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound {
            code: "TENANT_NOT_FOUND".to_string(),
            message: "租户不存在".to_string(),
        })?;
    if !matches!(tenant_status.as_str(), "pending" | "active") {
        return Err(AppError::Conflict {
            code: "TENANT_NOT_INVITABLE".to_string(),
            message: "只有待加入或运行中的租户可以邀请管理员".to_string(),
        });
    }

    let email = req.email.as_deref().map(normalize_email).transpose()?;
    if tenant_status == "active" && email.is_none() {
        return Err(AppError::bad_request(
            "ADMIN_EMAIL_REQUIRED",
            "请填写要邀请的管理员邮箱",
        ));
    }
    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if name.is_some_and(|value| value.chars().count() > 128) {
        return Err(AppError::bad_request(
            "ADMIN_NAME_INVALID",
            "管理员姓名不能超过 128 个字符",
        ));
    }
    if let Some(email) = email.as_deref() {
        let member_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM app_user u
                JOIN tenant_member tm ON tm.user_id = u.id
                WHERE tm.tenant_id = $1 AND lower(u.email) = lower($2)
            )",
        )
        .bind(tenant_id)
        .bind(email)
        .fetch_one(pool)
        .await?;
        if member_exists {
            return Err(AppError::Conflict {
                code: "TENANT_MEMBER_EXISTS".to_string(),
                message: "该账号已经是此租户成员".to_string(),
            });
        }
    }

    let token = format!("inv_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let expires_at = Utc::now() + Duration::days(req.expires_in_days.unwrap_or(7).clamp(1, 30));
    let mut transaction = pool.begin().await?;
    let mut row = sqlx::query(
        r#"
        UPDATE tenant_invitation
        SET token_hash = $3,
            expires_at = $4,
            name = COALESCE($5, name),
            status = 'pending',
            revoked_at = NULL,
            updated_at = NOW()
        WHERE id = (
            SELECT id
            FROM tenant_invitation
            WHERE tenant_id = $1
              AND accepted_at IS NULL
              AND status IN ('pending', 'expired', 'revoked')
              AND 'tenant_admin' = ANY(roles)
              AND ($2::text IS NULL OR lower(email) = lower($2))
            ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
            LIMIT 1
        )
        RETURNING id, email, expires_at
        "#,
    )
    .bind(tenant_id)
    .bind(email.as_deref())
    .bind(&token_hash)
    .bind(expires_at)
    .bind(name)
    .fetch_optional(&mut *transaction)
    .await?;

    if row.is_none() {
        let email = email.as_deref().ok_or_else(|| AppError::NotFound {
            code: "INITIAL_TENANT_INVITATION_NOT_FOUND".to_string(),
            message: "没有可重新生成的初始管理员邀请".to_string(),
        })?;
        row = Some(
            sqlx::query(
                r#"
                INSERT INTO tenant_invitation
                  (tenant_id, email, name, roles, kb_grants, token_hash, status, invited_by, expires_at)
                VALUES ($1, $2, $3, ARRAY['tenant_admin'], '[]'::jsonb, $4, 'pending', $5, $6)
                RETURNING id, email, expires_at
                "#,
            )
            .bind(tenant_id)
            .bind(email)
            .bind(name)
            .bind(&token_hash)
            .bind(actor.user_id)
            .bind(expires_at)
            .fetch_one(&mut *transaction)
            .await?,
        );
    }
    let row = row.ok_or_else(|| AppError::NotFound {
        code: "TENANT_INVITATION_NOT_FOUND".to_string(),
        message: "管理员邀请不存在".to_string(),
    })?;
    let invitation_id: Uuid = row.get("id");
    let invitation_email: String = row.get("email");
    sqlx::query(
        r#"
        INSERT INTO audit_log
          (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
        VALUES ($1, $2, 'super_admin', 'tenant.admin_invitation.generate',
                'tenant_invitation', $3, $4)
        "#,
    )
    .bind(tenant_id)
    .bind(actor.user_id)
    .bind(invitation_id.to_string())
    .bind(json!({
        "email": invitation_email,
        "expires_at": row.get::<chrono::DateTime<Utc>, _>("expires_at"),
    }))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    Ok(Json(json!({
        "id": invitation_id,
        "email": invitation_email,
        "expires_at": row.get::<chrono::DateTime<Utc>, _>("expires_at"),
        "invite_url": format!("/invite?token={token}"),
    })))
}

fn normalize_email(value: &str) -> Result<String, AppError> {
    let email = value.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') || email.chars().count() > 128 {
        return Err(AppError::bad_request("EMAIL_INVALID", "请输入有效邮箱"));
    }
    Ok(email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_admin_email() {
        assert_eq!(
            normalize_email(" Admin@Example.com ").unwrap(),
            "admin@example.com"
        );
        assert!(normalize_email("invalid").is_err());
    }
}
