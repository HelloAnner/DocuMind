use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

use crate::error::AppError;
use crate::state::AppState;

const MAX_TENANT_SLUG_LENGTH: usize = 63;

#[derive(Debug, Deserialize)]
pub struct TenantLoginQuery {
    tenant: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TenantLoginBranding {
    #[serde(skip_serializing_if = "Option::is_none")]
    kicker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    welcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tone: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TenantLoginContext {
    name: String,
    slug: String,
    branding: TenantLoginBranding,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/tenant-context", get(get_tenant_login_context))
        .route("/api/v1/auth/tenant-context", get(get_tenant_login_context))
}

async fn get_tenant_login_context(
    State(state): State<AppState>,
    Query(query): Query<TenantLoginQuery>,
) -> Result<Json<TenantLoginContext>, AppError> {
    let slug = normalize_tenant_slug(&query.tenant)?;
    let pool = state.db_pool.as_ref().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!(
            "tenant login context requires a database connection"
        ))
    })?;
    let row = sqlx::query(
        r#"
        SELECT name, slug, branding
        FROM tenant
        WHERE lower(slug) = lower($1)
          AND status = 'active'
        "#,
    )
    .bind(&slug)
    .fetch_optional(pool)
    .await?
    .ok_or_else(tenant_login_not_found)?;
    let branding = row.get::<Value, _>("branding");

    Ok(Json(TenantLoginContext {
        name: row.get("name"),
        slug: row.get("slug"),
        branding: parse_login_branding(&branding),
    }))
}

fn normalize_tenant_slug(value: &str) -> Result<String, AppError> {
    let slug = value.trim().to_ascii_lowercase();
    let valid = (2..=MAX_TENANT_SLUG_LENGTH).contains(&slug.len())
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !valid {
        return Err(tenant_login_not_found());
    }
    Ok(slug)
}

fn tenant_login_not_found() -> AppError {
    AppError::NotFound {
        code: "TENANT_LOGIN_NOT_FOUND".to_string(),
        message: "企业登录入口不存在或暂不可用".to_string(),
    }
}

fn parse_login_branding(value: &Value) -> TenantLoginBranding {
    TenantLoginBranding {
        kicker: branding_text(value, "login_kicker", 32),
        headline: branding_text(value, "login_headline", 64),
        description: branding_text(value, "login_description", 120),
        welcome: branding_text(value, "login_welcome", 40),
        tone: branding_tone(value),
    }
}

fn branding_text(value: &Value, key: &str, max_chars: usize) -> Option<String> {
    let text = value.get(key)?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(max_chars).collect())
}

fn branding_tone(value: &Value) -> Option<String> {
    let tone = value.get("login_tone")?.as_str()?.trim();
    match tone {
        "violet" | "azure" | "jade" | "amber" | "rose" => Some(tone.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_public_tenant_slug() {
        assert_eq!(normalize_tenant_slug("  Acme-01 ").unwrap(), "acme-01");
        assert!(normalize_tenant_slug("a").is_err());
        assert!(normalize_tenant_slug("acme_01").is_err());
        assert!(normalize_tenant_slug("租户").is_err());
    }

    #[test]
    fn exposes_only_supported_login_branding() {
        let branding = parse_login_branding(&json!({
            "login_kicker": "  可信知识，持续生长  ",
            "login_headline": "让经验成为共同的判断依据",
            "login_description": "连接团队文档与业务上下文。",
            "login_welcome": "欢迎回到知识中枢",
            "login_tone": "jade",
            "secret": "must-not-leak"
        }));
        assert_eq!(branding.kicker.as_deref(), Some("可信知识，持续生长"));
        assert_eq!(branding.tone.as_deref(), Some("jade"));
    }

    #[test]
    fn rejects_unknown_tone_and_empty_copy() {
        let branding = parse_login_branding(&json!({
            "login_kicker": " ",
            "login_tone": "neon"
        }));
        assert_eq!(branding.kicker, None);
        assert_eq!(branding.tone, None);
    }
}
