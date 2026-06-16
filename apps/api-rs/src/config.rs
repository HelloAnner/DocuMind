use std::env;

use anyhow::Result;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub server_host: String,
    pub server_port: u16,
    pub database_url: Option<String>,
    pub redis_url: Option<String>,
    pub jwt_secret: String,
    pub auth_token_expire_hours: i64,
    pub auth_login_mode: String,
    pub portal_base_url: String,
    pub portal_exchange_endpoint: String,
    pub default_tenant_id: Uuid,
    pub default_user_id: Uuid,
    pub default_role: String,
    pub default_kb_ids: Vec<Uuid>,
    pub default_tenant_name: String,
    pub default_tenant_slug: String,
    pub super_admin_user_id: Uuid,
    pub standard_user_id: Uuid,
    pub super_admin_email: String,
    pub super_admin_password: String,
    pub enterprise_admin_email: String,
    pub enterprise_admin_password: String,
    pub standard_user_email: String,
    pub standard_user_password: String,
    pub rag: RagConfig,
    pub agent: AgentConfig,
}

#[derive(Debug, Clone)]
pub struct RagConfig {
    pub rewrite: RewriteConfig,
    pub retrieval: RetrievalConfig,
    pub rerank: RerankConfig,
    pub generation: GenerationConfig,
    pub citation: CitationConfig,
}

#[derive(Debug, Clone)]
pub struct RewriteConfig {
    pub enabled: bool,
    pub hyde_enabled: bool,
    pub model: String,
}

#[derive(Debug, Clone)]
pub struct RetrievalConfig {
    pub dense_top_k: usize,
    pub bm25_top_k: usize,
    pub rrf_top_k: usize,
    pub effective_top_k: usize,
}

#[derive(Debug, Clone)]
pub struct RerankConfig {
    pub enabled: bool,
    pub model: String,
    pub min_score: f64,
}

#[derive(Debug, Clone)]
pub struct GenerationConfig {
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub use_real_llm: bool,
    pub temperature: f64,
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct CitationConfig {
    pub require_citation: bool,
    pub verify_claims: bool,
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub default_tone: String,
    pub proactive_followup: bool,
    pub max_followup_suggestions: usize,
    pub allow_analyst_mode: bool,
    pub require_citation_for_analysis: bool,
    pub clarification_style: String,
}

pub fn load_config() -> Result<AppConfig> {
    dotenvy::dotenv().ok();

    let server_host = env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let server_port = env::var("SERVER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5555);
    let database_url = env::var("DATABASE_URL").ok();
    let redis_url = env::var("REDIS_URL").ok();
    let jwt_secret =
        env::var("JWT_SECRET").unwrap_or_else(|_| "documind-dev-secret-change-me".to_string());
    let auth_token_expire_hours = env::var("AUTH_TOKEN_EXPIRE_HOURS")
        .or_else(|_| env::var("JWT_EXPIRE_HOURS"))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(24);
    let legacy_portal_auth = env_bool("PORTAL_MANAGED", false) && env_bool("PORTAL_AUTH_ENABLED", false);
    let auth_login_mode = normalize_auth_login_mode(&env::var("AUTH_LOGIN_MODE").unwrap_or_else(|_| {
        if legacy_portal_auth {
            "portal".to_string()
        } else {
            "local".to_string()
        }
    }));
    let portal_base_url =
        env::var("PORTAL_BASE_URL").unwrap_or_else(|_| "http://localhost:8080".to_string());
    let portal_exchange_endpoint = env::var("PORTAL_EXCHANGE_ENDPOINT")
        .unwrap_or_else(|_| "/api/auth/exchange-ticket".to_string());

    let default_tenant_id = env::var("DEFAULT_TENANT_ID")
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .unwrap_or_else(|| Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap());

    let default_user_id = env::var("DEFAULT_USER_ID")
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .unwrap_or_else(|| Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap());

    let default_role = env::var("DEFAULT_ROLE").unwrap_or_else(|_| "enterprise_admin".to_string());
    let default_tenant_name =
        env::var("DEFAULT_TENANT_NAME").unwrap_or_else(|_| "Acme Corp".to_string());
    let default_tenant_slug =
        env::var("DEFAULT_TENANT_SLUG").unwrap_or_else(|_| "acme".to_string());
    let super_admin_user_id = env::var("SUPER_ADMIN_USER_ID")
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .unwrap_or_else(|| Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap());
    let standard_user_id = env::var("STANDARD_USER_ID")
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .unwrap_or_else(|| Uuid::parse_str("00000000-0000-0000-0000-000000000004").unwrap());
    let super_admin_email =
        env::var("SUPER_ADMIN_EMAIL").unwrap_or_else(|_| "ops@documind.local".to_string());
    let super_admin_password =
        env::var("SUPER_ADMIN_PASSWORD").unwrap_or_else(|_| "documind123".to_string());
    let enterprise_admin_email =
        env::var("ENTERPRISE_ADMIN_EMAIL").unwrap_or_else(|_| "admin@documind.local".to_string());
    let enterprise_admin_password =
        env::var("ENTERPRISE_ADMIN_PASSWORD").unwrap_or_else(|_| "documind123".to_string());
    let standard_user_email =
        env::var("STANDARD_USER_EMAIL").unwrap_or_else(|_| "user@documind.local".to_string());
    let standard_user_password =
        env::var("STANDARD_USER_PASSWORD").unwrap_or_else(|_| "documind123".to_string());

    let default_kb_ids: Vec<Uuid> = env::var("DEFAULT_KB_IDS")
        .ok()
        .map(|v| {
            v.split(',')
                .filter_map(|s| Uuid::parse_str(s.trim()).ok())
                .collect()
        })
        .unwrap_or_else(|| vec![Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap()]);

    let rag = RagConfig {
        rewrite: RewriteConfig {
            enabled: env::var("RAG_REWRITE_ENABLED")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(true),
            hyde_enabled: env::var("RAG_HYDE_ENABLED")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(true),
            model: env::var("RAG_REWRITE_MODEL").unwrap_or_else(|_| "qwen-turbo".to_string()),
        },
        retrieval: RetrievalConfig {
            dense_top_k: env::var("RAG_DENSE_TOP_K")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(100),
            bm25_top_k: env::var("RAG_BM25_TOP_K")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(100),
            rrf_top_k: env::var("RAG_RRF_TOP_K")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(20),
            effective_top_k: env::var("RAG_TOP_K")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
        },
        rerank: RerankConfig {
            enabled: env::var("RAG_RERANK_ENABLED")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(true),
            model: env::var("RAG_RERANK_MODEL")
                .unwrap_or_else(|_| "bge-reranker-v2-m3".to_string()),
            min_score: env::var("RAG_RERANK_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.3),
        },
        generation: GenerationConfig {
            model: env::var("LLM_MODEL").unwrap_or_else(|_| "qwen-turbo".to_string()),
            base_url: env::var("LLM_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:11434/v1".to_string()),
            api_key: env::var("LLM_API_KEY").unwrap_or_else(|_| "ollama".to_string()),
            use_real_llm: env::var("USE_REAL_LLM")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(false),
            temperature: env::var("LLM_TEMPERATURE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.2),
            max_output_tokens: env::var("LLM_MAX_OUTPUT_TOKENS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1200),
        },
        citation: CitationConfig {
            require_citation: env::var("RAG_REQUIRE_CITATION")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(true),
            verify_claims: env::var("RAG_VERIFY_CLAIMS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(true),
        },
    };

    let agent = AgentConfig {
        default_tone: env::var("AGENT_DEFAULT_TONE").unwrap_or_else(|_| "concise_warm".to_string()),
        proactive_followup: env::var("AGENT_PROACTIVE_FOLLOWUP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(true),
        max_followup_suggestions: env::var("AGENT_MAX_FOLLOWUP_SUGGESTIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2),
        allow_analyst_mode: env::var("AGENT_ALLOW_ANALYST_MODE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(true),
        require_citation_for_analysis: env::var("AGENT_REQUIRE_CITATION_FOR_ANALYSIS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(true),
        clarification_style: env::var("AGENT_CLARIFICATION_STYLE")
            .unwrap_or_else(|_| "short".to_string()),
    };

    Ok(AppConfig {
        server_host,
        server_port,
        database_url,
        redis_url,
        jwt_secret,
        auth_token_expire_hours,
        auth_login_mode,
        portal_base_url,
        portal_exchange_endpoint,
        default_tenant_id,
        default_user_id,
        default_role,
        default_kb_ids,
        default_tenant_name,
        default_tenant_slug,
        super_admin_user_id,
        standard_user_id,
        super_admin_email,
        super_admin_password,
        enterprise_admin_email,
        enterprise_admin_password,
        standard_user_email,
        standard_user_password,
        rag,
        agent,
    })
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

fn normalize_auth_login_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "portal" | "portal_sso" | "portal-managed" | "portal_managed" => "portal".to_string(),
        _ => "local".to_string(),
    }
}
