use async_trait::async_trait;
use axum::extract::{FromRequestParts, State};
use axum::http::{header, request::Parts, HeaderMap, Request};
use axum::middleware::Next;
use axum::response::Response;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::CurrentActor;
use crate::state::AppState;

pub const DEFAULT_SCOPES: [&str; 3] = ["knowledge_bases:read", "chat:write", "conversations:read"];

pub struct ApiActorExtractor(pub CurrentActor);

#[async_trait]
impl FromRequestParts<AppState> for ApiActorExtractor {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        actor_from_api_headers(state, &parts.headers)
            .await?
            .map(Self)
            .ok_or_else(api_token_invalid)
    }
}

#[derive(Serialize)]
struct ApiIdentity {
    client_id: Uuid,
    client_name: String,
    tenant_id: Uuid,
    scopes: Vec<String>,
    allowed_kb_ids: Vec<Uuid>,
    token_expires_at: DateTime<Utc>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/external/me", axum::routing::get(me))
        .route(
            "/api/v1/external/knowledge-bases",
            axum::routing::get(list_knowledge_bases),
        )
        .route(
            "/api/v1/external/conversations",
            axum::routing::post(crate::api::conversations::create_conversation)
                .get(crate::api::conversations::list_conversations),
        )
        .route(
            "/api/v1/external/conversations/:conversation_id",
            axum::routing::get(crate::api::conversations::get_conversation),
        )
        .route(
            "/api/v1/external/conversations/:conversation_id/messages",
            axum::routing::get(crate::api::conversations::get_messages)
                .post(crate::api::conversations::send_message),
        )
        .route(
            "/api/v1/external/conversations/:conversation_id/messages/:message_id/traces",
            axum::routing::get(crate::api::conversations::get_message_traces),
        )
        .route_layer(axum::middleware::from_fn(require_api_token_header))
}

async fn require_api_token_header(
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AppError> {
    let valid = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value.starts_with("dm_live_"));
    if !valid {
        return Err(api_token_invalid());
    }
    Ok(next.run(request).await)
}

async fn me(ApiActorExtractor(actor): ApiActorExtractor) -> Result<Json<ApiIdentity>, AppError> {
    Ok(Json(ApiIdentity {
        client_id: actor.api_client_id.ok_or_else(api_token_invalid)?,
        client_name: actor.name,
        tenant_id: actor.tenant_id,
        scopes: actor.api_scopes,
        allowed_kb_ids: actor.allowed_kb_ids,
        token_expires_at: actor.api_token_expires_at.ok_or_else(api_token_invalid)?,
    }))
}

async fn list_knowledge_bases(
    State(state): State<AppState>,
    ApiActorExtractor(actor): ApiActorExtractor,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    require_scope(&actor, "knowledge_bases:read")?;
    let pool = state.db_pool.as_ref().ok_or_else(api_database_required)?;
    let rows = sqlx::query(
        "SELECT id, name, description, status, tags, updated_at
         FROM knowledge_base
         WHERE tenant_id = $1 AND id = ANY($2) AND status = 'active'
         ORDER BY name",
    )
    .bind(actor.tenant_id)
    .bind(&actor.allowed_kb_ids)
    .fetch_all(pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| {
                serde_json::json!({
                    "id": row.get::<Uuid, _>("id"),
                    "name": row.get::<String, _>("name"),
                    "description": row.try_get::<String, _>("description").ok(),
                    "status": row.get::<String, _>("status"),
                    "tags": row.get::<Vec<String>, _>("tags"),
                    "updated_at": row.get::<DateTime<Utc>, _>("updated_at"),
                })
            })
            .collect(),
    ))
}

pub async fn actor_from_api_headers(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<CurrentActor>, AppError> {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| value.starts_with("dm_live_"))
    else {
        return Ok(None);
    };
    let token_id = parse_token_id(token).ok_or_else(api_token_invalid)?;
    let pool = state.db_pool.as_ref().ok_or_else(api_database_required)?;
    let row = sqlx::query(
        r#"
        SELECT tok.secret_hash, tok.status AS token_status, tok.expires_at,
               client.id AS client_id, client.name AS client_name,
               client.tenant_id, client.service_user_id, client.scopes,
               client.status AS client_status, client.rate_limit_per_minute
        FROM api_token tok
        JOIN api_client client ON client.id = tok.client_id
        JOIN tenant t ON t.id = client.tenant_id
        WHERE tok.id = $1 AND t.status = 'active'
        LIMIT 1
        "#,
    )
    .bind(token_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(api_token_invalid)?;

    let token_status: String = row.get("token_status");
    let client_status: String = row.get("client_status");
    let expires_at: DateTime<Utc> = row.get("expires_at");
    if token_status != "active" {
        return Err(AppError::Unauthorized {
            code: "API_TOKEN_REVOKED".to_string(),
            message: "API Token 已被吊销".to_string(),
        });
    }
    if client_status != "active" {
        return Err(AppError::Unauthorized {
            code: "API_CLIENT_DISABLED".to_string(),
            message: "API 接入已被停用".to_string(),
        });
    }
    if expires_at <= Utc::now() {
        return Err(AppError::Unauthorized {
            code: "API_TOKEN_EXPIRED".to_string(),
            message: "API Token 已过期".to_string(),
        });
    }
    let expected: String = row.get("secret_hash");
    if !constant_time_eq(expected.as_bytes(), token_hash(token).as_bytes()) {
        return Err(api_token_invalid());
    }

    enforce_rate_limit(state, token_id, row.get::<i32, _>("rate_limit_per_minute")).await?;

    let tenant_id: Uuid = row.get("tenant_id");
    let service_user_id: Uuid = row.get("service_user_id");
    let mut actor =
        crate::auth::resolve_actor_from_db(
            pool,
            tenant_id,
            service_user_id,
            "end_user",
            "tenant",
        )
        .await?;
    let scopes: Vec<String> = row.get("scopes");
    actor
        .permissions
        .retain(|permission| permission_allowed(&scopes, permission));
    actor.allowed_kb_ids = sqlx::query_scalar(
        "SELECT kb_id FROM knowledge_base_acl
         WHERE tenant_id = $1 AND subject_type = 'user' AND subject_id = $2
           AND permission IN ('read', 'write', 'manage')",
    )
    .bind(tenant_id)
    .bind(service_user_id.to_string())
    .fetch_all(pool)
    .await?;
    actor.api_client_id = Some(row.get("client_id"));
    actor.api_token_id = Some(token_id);
    actor.api_scopes = scopes;
    actor.api_token_expires_at = Some(expires_at);
    actor.name = row.get("client_name");

    sqlx::query("UPDATE api_token SET last_used_at = NOW() WHERE id = $1")
        .bind(token_id)
        .execute(pool)
        .await?;
    Ok(Some(actor))
}

pub fn require_scope(actor: &CurrentActor, scope: &str) -> Result<(), AppError> {
    if actor.api_scopes.iter().any(|value| value == scope) {
        Ok(())
    } else {
        Err(AppError::Forbidden {
            code: "API_SCOPE_DENIED".to_string(),
            message: format!("API Client 缺少 {scope} 权限"),
        })
    }
}

pub fn generate_token(token_id: Uuid) -> String {
    format!(
        "dm_live_{}_{}{}",
        token_id,
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn token_prefix(token: &str) -> String {
    token.chars().take(24).collect()
}

fn parse_token_id(token: &str) -> Option<Uuid> {
    let rest = token.strip_prefix("dm_live_")?;
    Uuid::parse_str(rest.get(..36)?).ok()
}

fn permission_allowed(scopes: &[String], permission: &str) -> bool {
    match permission {
        "kb.read" => scopes
            .iter()
            .any(|scope| scope == "knowledge_bases:read" || scope == "chat:write"),
        "chat.ask" | "answer.feedback" => scopes.iter().any(|scope| scope == "chat:write"),
        _ => false,
    }
}

async fn enforce_rate_limit(state: &AppState, token_id: Uuid, limit: i32) -> Result<(), AppError> {
    let Some(client) = &state.redis_client else {
        return Ok(());
    };
    let minute = Utc::now().timestamp() / 60;
    let key = format!("documind:external-rate:{token_id}:{minute}");
    let mut connection = client.get_multiplexed_async_connection().await?;
    let count: i64 = connection.incr(&key, 1).await?;
    if count == 1 {
        let _: bool = connection.expire(&key, 120).await?;
    }
    if count > i64::from(limit) {
        return Err(AppError::RateLimited {
            code: "API_RATE_LIMITED".to_string(),
            message: "API 请求超过当前分钟限额".to_string(),
        });
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn api_token_invalid() -> AppError {
    AppError::Unauthorized {
        code: "INVALID_API_TOKEN".to_string(),
        message: "API Token 无效".to_string(),
    }
}

fn api_database_required() -> AppError {
    AppError::bad_request("DATABASE_REQUIRED", "外部 API 需要 PostgreSQL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_can_be_parsed_and_hashed() {
        let id = Uuid::new_v4();
        let token = generate_token(id);
        assert_eq!(parse_token_id(&token), Some(id));
        assert_eq!(token_hash(&token).len(), 64);
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
    }
}
