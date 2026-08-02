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

    let token = format!("inv_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let expires_at = Utc::now() + Duration::days(req.expires_in_days.unwrap_or(7).clamp(1, 30));
    let mut transaction = pool.begin().await?;
    let row = sqlx::query(
        r#"
        INSERT INTO tenant_invitation
          (tenant_id, email, name, roles, kb_grants, token_hash, status, invited_by, expires_at)
        VALUES ($1, NULL, NULL, ARRAY['tenant_admin'], '[]'::jsonb, $2, 'pending', $3, $4)
        ON CONFLICT (tenant_id) WHERE status = 'pending' AND email IS NULL
        DO UPDATE SET token_hash = EXCLUDED.token_hash,
                      expires_at = EXCLUDED.expires_at,
                      revoked_at = NULL,
                      updated_at = NOW()
        RETURNING id, expires_at
        "#,
    )
    .bind(tenant_id)
    .bind(&token_hash)
    .bind(actor.user_id)
    .bind(expires_at)
    .fetch_one(&mut *transaction)
    .await?;
    let invitation_id: Uuid = row.get("id");
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
        "expires_at": row.get::<chrono::DateTime<Utc>, _>("expires_at"),
    }))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;

    Ok(Json(json!({
        "id": invitation_id,
        "expires_at": row.get::<chrono::DateTime<Utc>, _>("expires_at"),
        "invite_url": format!("/invite?token={token}"),
    })))
}
