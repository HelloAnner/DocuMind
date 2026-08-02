use axum::extract::{Path, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::api::admin_api_clients_model::{
    normalize_name, normalize_scopes, validate_expiration, ClientSummary, CreateClientRequest,
    CreateTokenRequest, CreatedClient, CreatedToken, TokenSummary, UpdateClientRequest,
};
use crate::api::external_api::{generate_token, token_hash, token_prefix};
use crate::auth::{record_audit_event, require_permission, require_tenant_admin, ActorExtractor};
use crate::error::AppError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/admin/api-clients",
            get(list_clients).post(create_client),
        )
        .route("/api/admin/api-clients/:client_id", patch(update_client))
        .route(
            "/api/admin/api-clients/:client_id/tokens",
            post(create_token),
        )
        .route(
            "/api/admin/api-clients/:client_id/tokens/:token_id/revoke",
            post(revoke_token),
        )
}

async fn list_clients(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
) -> Result<Json<Vec<ClientSummary>>, AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "api_client.read")?;
    let pool = state.db_pool.as_ref().ok_or_else(database_required)?;
    let rows = sqlx::query(
        "SELECT id, name, description, scopes, status, rate_limit_per_minute, service_user_id, created_at
         FROM api_client WHERE tenant_id = $1 ORDER BY created_at DESC",
    )
    .bind(actor.tenant_id)
    .fetch_all(pool)
    .await?;
    let mut clients = Vec::with_capacity(rows.len());
    for row in rows {
        let client_id: Uuid = row.get("id");
        let service_user_id: Uuid = row.get("service_user_id");
        let kb_ids = sqlx::query_scalar(
            "SELECT kb_id FROM knowledge_base_acl
             WHERE tenant_id = $1 AND subject_type = 'user' AND subject_id = $2
               AND permission IN ('read', 'write', 'manage') ORDER BY kb_id",
        )
        .bind(actor.tenant_id)
        .bind(service_user_id.to_string())
        .fetch_all(pool)
        .await?;
        let token_rows = sqlx::query(
            "SELECT id, token_prefix, status, expires_at, last_used_at, created_at
             FROM api_token WHERE client_id = $1 ORDER BY created_at DESC",
        )
        .bind(client_id)
        .fetch_all(pool)
        .await?;
        clients.push(ClientSummary {
            id: client_id,
            name: row.get("name"),
            description: row.try_get("description").ok(),
            scopes: row.get("scopes"),
            status: row.get("status"),
            rate_limit_per_minute: row.get("rate_limit_per_minute"),
            kb_ids,
            tokens: token_rows.into_iter().map(token_summary).collect(),
            created_at: row.get("created_at"),
        });
    }
    Ok(Json(clients))
}

async fn create_client(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Json(request): Json<CreateClientRequest>,
) -> Result<Json<CreatedClient>, AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "api_client.write")?;
    let name = normalize_name(&request.name)?;
    let scopes = normalize_scopes(request.scopes)?;
    validate_expiration(request.expires_in_days)?;
    if !(1..=10_000).contains(&request.rate_limit_per_minute) {
        return Err(AppError::bad_request(
            "API_RATE_LIMIT_INVALID",
            "每分钟限额必须在 1 到 10000 之间",
        ));
    }
    let pool = state.db_pool.as_ref().ok_or_else(database_required)?;
    ensure_kbs(pool, actor.tenant_id, &request.kb_ids).await?;

    let client_id = Uuid::new_v4();
    let service_user_id = Uuid::new_v4();
    let token_id = Uuid::new_v4();
    let secret = generate_token(token_id);
    let expires_at = Utc::now() + Duration::days(request.expires_in_days);
    let mut transaction = pool.begin().await?;
    sqlx::query(
        "INSERT INTO app_user (id, email, name, auth_provider, status)
         VALUES ($1, $2, $3, 'api', 'active')",
    )
    .bind(service_user_id)
    .bind(format!("api-{service_user_id}@internal.documind"))
    .bind(&name)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO tenant_member (tenant_id, user_id, roles, status, joined_at)
         VALUES ($1, $2, ARRAY['end_user'], 'active', NOW())",
    )
    .bind(actor.tenant_id)
    .bind(service_user_id)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "INSERT INTO api_client
         (id, tenant_id, service_user_id, name, description, scopes, rate_limit_per_minute, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(client_id)
    .bind(actor.tenant_id)
    .bind(service_user_id)
    .bind(&name)
    .bind(request.description.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(&scopes)
    .bind(request.rate_limit_per_minute)
    .bind(actor.user_id)
    .execute(&mut *transaction)
    .await?;
    for kb_id in &request.kb_ids {
        sqlx::query(
            "INSERT INTO knowledge_base_acl
             (tenant_id, kb_id, subject_type, subject_id, permission, created_by)
             VALUES ($1, $2, 'user', $3, 'read', $4)
             ON CONFLICT DO NOTHING",
        )
        .bind(actor.tenant_id)
        .bind(kb_id)
        .bind(service_user_id.to_string())
        .bind(actor.user_id)
        .execute(&mut *transaction)
        .await?;
    }
    insert_token(
        &mut transaction,
        token_id,
        client_id,
        &secret,
        expires_at,
        actor.user_id,
    )
    .await?;
    transaction.commit().await?;

    record_audit_event(
        &state,
        Some(&actor),
        "api_client.create",
        Some("api_client"),
        Some(&client_id.to_string()),
        json!({"name": name, "scopes": scopes, "kb_ids": request.kb_ids, "token_prefix": token_prefix(&secret)}),
    )
    .await?;
    let client = fetch_client(pool, actor.tenant_id, client_id).await?;
    Ok(Json(CreatedClient {
        client,
        token: secret,
    }))
}

async fn create_token(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(client_id): Path<Uuid>,
    Json(request): Json<CreateTokenRequest>,
) -> Result<Json<CreatedToken>, AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "api_client.write")?;
    validate_expiration(request.expires_in_days)?;
    let pool = state.db_pool.as_ref().ok_or_else(database_required)?;
    ensure_client(pool, actor.tenant_id, client_id).await?;
    let token_id = Uuid::new_v4();
    let secret = generate_token(token_id);
    let expires_at = Utc::now() + Duration::days(request.expires_in_days);
    let mut transaction = pool.begin().await?;
    insert_token(
        &mut transaction,
        token_id,
        client_id,
        &secret,
        expires_at,
        actor.user_id,
    )
    .await?;
    transaction.commit().await?;
    record_audit_event(
        &state,
        Some(&actor),
        "api_token.create",
        Some("api_token"),
        Some(&token_id.to_string()),
        json!({"client_id": client_id, "token_prefix": token_prefix(&secret), "expires_at": expires_at}),
    )
    .await?;
    Ok(Json(CreatedToken {
        token: TokenSummary {
            id: token_id,
            token_prefix: token_prefix(&secret),
            status: "active".to_string(),
            expires_at,
            last_used_at: None,
            created_at: Utc::now(),
        },
        secret,
    }))
}

async fn revoke_token(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path((client_id, token_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "api_client.revoke")?;
    let pool = state.db_pool.as_ref().ok_or_else(database_required)?;
    let result = sqlx::query(
        "UPDATE api_token tok SET status = 'revoked', revoked_at = NOW(), revoked_by = $4
         FROM api_client client
         WHERE tok.id = $1 AND tok.client_id = $2 AND client.id = tok.client_id
           AND client.tenant_id = $3 AND tok.status = 'active'",
    )
    .bind(token_id)
    .bind(client_id)
    .bind(actor.tenant_id)
    .bind(actor.user_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(token_not_found());
    }
    record_audit_event(
        &state,
        Some(&actor),
        "api_token.revoke",
        Some("api_token"),
        Some(&token_id.to_string()),
        json!({"client_id": client_id}),
    )
    .await?;
    Ok(Json(json!({"id": token_id, "status": "revoked"})))
}

async fn update_client(
    State(state): State<AppState>,
    ActorExtractor(actor): ActorExtractor,
    Path(client_id): Path<Uuid>,
    Json(request): Json<UpdateClientRequest>,
) -> Result<Json<ClientSummary>, AppError> {
    require_tenant_admin(&actor)?;
    require_permission(&actor, "api_client.write")?;
    if request.status != "active" && request.status != "disabled" {
        return Err(AppError::bad_request(
            "API_CLIENT_STATUS_INVALID",
            "状态只能是 active 或 disabled",
        ));
    }
    let pool = state.db_pool.as_ref().ok_or_else(database_required)?;
    let result = sqlx::query(
        "UPDATE api_client SET status = $3, updated_at = NOW() WHERE id = $1 AND tenant_id = $2",
    )
    .bind(client_id)
    .bind(actor.tenant_id)
    .bind(&request.status)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(client_not_found());
    }
    record_audit_event(
        &state,
        Some(&actor),
        "api_client.status_update",
        Some("api_client"),
        Some(&client_id.to_string()),
        json!({"status": request.status}),
    )
    .await?;
    Ok(Json(fetch_client(pool, actor.tenant_id, client_id).await?))
}

async fn insert_token(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    token_id: Uuid,
    client_id: Uuid,
    secret: &str,
    expires_at: DateTime<Utc>,
    created_by: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO api_token
         (id, client_id, token_prefix, secret_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(token_id)
    .bind(client_id)
    .bind(token_prefix(secret))
    .bind(token_hash(secret))
    .bind(expires_at)
    .bind(created_by)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn fetch_client(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    client_id: Uuid,
) -> Result<ClientSummary, AppError> {
    let row = sqlx::query(
        "SELECT id, name, description, scopes, status, rate_limit_per_minute, service_user_id, created_at
         FROM api_client WHERE tenant_id = $1 AND id = $2",
    )
    .bind(tenant_id)
    .bind(client_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(client_not_found)?;
    let service_user_id: Uuid = row.get("service_user_id");
    let kb_ids = sqlx::query_scalar(
        "SELECT kb_id FROM knowledge_base_acl
         WHERE tenant_id = $1 AND subject_type = 'user' AND subject_id = $2 ORDER BY kb_id",
    )
    .bind(tenant_id)
    .bind(service_user_id.to_string())
    .fetch_all(pool)
    .await?;
    let tokens = sqlx::query(
        "SELECT id, token_prefix, status, expires_at, last_used_at, created_at
         FROM api_token WHERE client_id = $1 ORDER BY created_at DESC",
    )
    .bind(client_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(token_summary)
    .collect();
    Ok(ClientSummary {
        id: row.get("id"),
        name: row.get("name"),
        description: row.try_get("description").ok(),
        scopes: row.get("scopes"),
        status: row.get("status"),
        rate_limit_per_minute: row.get("rate_limit_per_minute"),
        kb_ids,
        tokens,
        created_at: row.get("created_at"),
    })
}

fn token_summary(row: sqlx::postgres::PgRow) -> TokenSummary {
    TokenSummary {
        id: row.get("id"),
        token_prefix: row.get("token_prefix"),
        status: row.get("status"),
        expires_at: row.get("expires_at"),
        last_used_at: row.try_get("last_used_at").ok(),
        created_at: row.get("created_at"),
    }
}

async fn ensure_client(
    pool: &sqlx::PgPool,
    tenant_id: Uuid,
    client_id: Uuid,
) -> Result<(), AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM api_client WHERE tenant_id = $1 AND id = $2)",
    )
    .bind(tenant_id)
    .bind(client_id)
    .fetch_one(pool)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(client_not_found())
    }
}

async fn ensure_kbs(pool: &sqlx::PgPool, tenant_id: Uuid, kb_ids: &[Uuid]) -> Result<(), AppError> {
    if kb_ids.is_empty() {
        return Err(AppError::bad_request(
            "API_CLIENT_KB_REQUIRED",
            "请至少授权一个知识库",
        ));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT id) FROM knowledge_base WHERE tenant_id = $1 AND id = ANY($2) AND status = 'active'",
    )
    .bind(tenant_id)
    .bind(kb_ids)
    .fetch_one(pool)
    .await?;
    if count
        != kb_ids
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>()
            .len() as i64
    {
        return Err(AppError::kb_scope_denied());
    }
    Ok(())
}

fn database_required() -> AppError {
    AppError::bad_request("DATABASE_REQUIRED", "API 接入管理需要 PostgreSQL")
}
fn client_not_found() -> AppError {
    AppError::NotFound {
        code: "API_CLIENT_NOT_FOUND".to_string(),
        message: "API Client 不存在".to_string(),
    }
}
fn token_not_found() -> AppError {
    AppError::NotFound {
        code: "API_TOKEN_NOT_FOUND".to_string(),
        message: "API Token 不存在或已吊销".to_string(),
    }
}
