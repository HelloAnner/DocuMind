use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::external_api::DEFAULT_SCOPES;
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub(crate) struct CreateClientRequest {
    pub name: String,
    pub description: Option<String>,
    pub kb_ids: Vec<Uuid>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default = "default_expires_in_days")]
    pub expires_in_days: i64,
    #[serde(default = "default_rate_limit")]
    pub rate_limit_per_minute: i32,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreateTokenRequest {
    #[serde(default = "default_expires_in_days")]
    pub expires_in_days: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UpdateClientRequest {
    pub status: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ClientSummary {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub scopes: Vec<String>,
    pub status: String,
    pub rate_limit_per_minute: i32,
    pub kb_ids: Vec<Uuid>,
    pub tokens: Vec<TokenSummary>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TokenSummary {
    pub id: Uuid,
    pub token_prefix: String,
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CreatedClient {
    pub client: ClientSummary,
    pub token: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CreatedToken {
    pub token: TokenSummary,
    pub secret: String,
}

pub(crate) fn normalize_name(value: &str) -> Result<String, AppError> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 128 {
        return Err(AppError::bad_request(
            "API_CLIENT_NAME_INVALID",
            "应用名称长度必须为 1 到 128 个字符",
        ));
    }
    Ok(name.to_string())
}

pub(crate) fn normalize_scopes(scopes: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut scopes = if scopes.is_empty() {
        DEFAULT_SCOPES
            .iter()
            .map(|value| value.to_string())
            .collect()
    } else {
        scopes
    };
    if scopes
        .iter()
        .any(|scope| !DEFAULT_SCOPES.contains(&scope.as_str()))
    {
        return Err(AppError::bad_request(
            "API_SCOPE_INVALID",
            "存在不支持的 API Scope",
        ));
    }
    scopes.sort();
    scopes.dedup();
    Ok(scopes)
}

pub(crate) fn validate_expiration(days: i64) -> Result<(), AppError> {
    if (1..=365).contains(&days) {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "API_TOKEN_EXPIRATION_INVALID",
            "Token 有效期必须为 1 到 365 天",
        ))
    }
}

fn default_expires_in_days() -> i64 {
    90
}

fn default_rate_limit() -> i32 {
    60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_scopes_and_expiration() {
        assert_eq!(normalize_scopes(vec![]).unwrap().len(), 3);
        assert!(normalize_scopes(vec!["admin:write".to_string()]).is_err());
        assert!(validate_expiration(90).is_ok());
        assert!(validate_expiration(0).is_err());
    }
}
