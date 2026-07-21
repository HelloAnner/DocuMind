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
pub struct ResendInitialInvitationRequest {
    expires_in_days: Option<i64>,
}

pub async fn resend_initial_invitation(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(tenant_id): Path<Uuid>,
    Json(req): Json<ResendInitialInvitationRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_super_admin(&actor)?;
    let pool = state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::bad_request("DB_REQUIRED", "租户管理功能需要数据库"))?;
    let token = format!("inv_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let expires_at = Utc::now() + Duration::days(req.expires_in_days.unwrap_or(7).clamp(1, 30));
    let row = sqlx::query(
        r#"
        UPDATE tenant_invitation
        SET token_hash = $2,
            expires_at = $3,
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
              AND EXISTS (
                SELECT 1 FROM tenant t
                WHERE t.id = tenant_invitation.tenant_id
                  AND t.status <> 'deletion_pending'
              )
            ORDER BY created_at DESC
            LIMIT 1
        )
          AND tenant_id = $1
        RETURNING id, email, expires_at
        "#,
    )
    .bind(tenant_id)
    .bind(&token_hash)
    .bind(expires_at)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound {
        code: "INITIAL_TENANT_INVITATION_NOT_FOUND".to_string(),
        message: "没有可重发的初始管理员邀请".to_string(),
    })?;
    let invitation_id: Uuid = row.get("id");
    sqlx::query(
        r#"
        INSERT INTO audit_log
          (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
        VALUES ($1, $2, 'super_admin', 'tenant.initial_invitation.resend',
                'tenant_invitation', $3, $4)
        "#,
    )
    .bind(tenant_id)
    .bind(actor.user_id)
    .bind(invitation_id.to_string())
    .bind(json!({
        "email": row.get::<String, _>("email"),
        "expires_at": row.get::<chrono::DateTime<Utc>, _>("expires_at"),
    }))
    .execute(pool)
    .await?;
    Ok(Json(json!({
        "id": invitation_id,
        "email": row.get::<String, _>("email"),
        "expires_at": row.get::<chrono::DateTime<Utc>, _>("expires_at"),
        "invite_url": format!("/invite?token={token}"),
    })))
}
