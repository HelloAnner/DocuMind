use std::env;

use anyhow::{anyhow, Result};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub environment: RuntimeEnvironment,
    pub server_host: String,
    pub server_port: u16,
    pub database_url: Option<String>,
    pub redis_url: Option<String>,
    pub rabbitmq_url: Option<String>,
    pub elasticsearch_url: Option<String>,
    pub object_storage_provider: String,
    pub object_storage_endpoint: Option<String>,
    pub object_storage_region: String,
    pub object_storage_bucket: String,
    pub object_storage_access_key: Option<String>,
    pub object_storage_secret_key: Option<String>,
    pub object_storage_force_path_style: bool,
    pub object_storage_tls_verify: bool,
    pub object_storage_presign_expire_seconds: u64,
    pub blob_storage_dir: String,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEnvironment {
    Development,
    Production,
}

impl RuntimeEnvironment {
    pub fn from_env_value(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "prod" | "production" | "release" => Self::Production,
            _ => Self::Development,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Production => "production",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RagConfig {
    pub rewrite: RewriteConfig,
    pub retrieval: RetrievalConfig,
    pub rerank: RerankConfig,
    pub embedding: EmbeddingConfig,
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
    pub provider: String,
    pub model: String,
    pub api_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EmbeddingConfig {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub batch_size: usize,
    pub dimension: usize,
    pub retry_max: i32,
    pub worker_poll_ms: u64,
    pub index_schema_version: u32,
    pub index_name: String,
    pub index_alias: String,
    pub enabled: bool,
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
    pub verify_consensus: bool,
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub reasoning_model: String,
    pub default_tone: String,
    pub proactive_followup: bool,
    pub max_followup_suggestions: usize,
    pub allow_analyst_mode: bool,
    pub require_citation_for_analysis: bool,
    pub clarification_style: String,
    pub max_react_steps: usize,
    pub max_queries_per_step: usize,
    pub max_history_turns: usize,
    pub max_history_chars: usize,
    pub max_context_chars: usize,
    pub max_repair_attempts: usize,
    pub total_timeout_seconds: u64,
}

fn env_str(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_opt(key: &str) -> Option<String> {
    env::var(key).ok()
}

fn env_nonempty(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_uuid(key: &str, default: &str) -> Uuid {
    env::var(key)
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .unwrap_or_else(|| Uuid::parse_str(default).unwrap())
}

fn env_first_str(keys: &[&str], default: &str) -> String {
    keys.iter()
        .find_map(|k| env::var(k).ok())
        .unwrap_or_else(|| default.to_string())
}

fn env_first_parse<T: std::str::FromStr>(keys: &[&str], default: T) -> T {
    keys.iter()
        .find_map(|k| env::var(k).ok().and_then(|v| v.parse().ok()))
        .unwrap_or(default)
}

fn env_first_nonempty(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| env::var(k).ok()).filter(|v| !v.trim().is_empty())
}

pub fn load_config() -> Result<AppConfig> {
    let environment = env::var("DOCUMIND_ENV")
        .or_else(|_| env::var("APP_ENV"))
        .or_else(|_| env::var("RUST_ENV"))
        .map(|value| RuntimeEnvironment::from_env_value(&value))
        .unwrap_or(RuntimeEnvironment::Development);
    let server_host = env_str("SERVER_HOST", "127.0.0.1");
    let server_port = env_parse("SERVER_PORT", 8089u16);
    let database_url = env_opt("DATABASE_URL");
    let redis_url = env_opt("REDIS_URL");
    let rabbitmq_url = env_opt("RABBITMQ_URL");
    let elasticsearch_url = env_opt("ELASTICSEARCH_URL");
    let object_storage_provider = env_str("OBJECT_STORAGE_PROVIDER", "minio");
    let object_storage_endpoint = env_opt("OBJECT_STORAGE_ENDPOINT");
    let object_storage_region = env_str("OBJECT_STORAGE_REGION", "us-east-1");
    let object_storage_bucket = env_str("OBJECT_STORAGE_BUCKET", "documind");
    let object_storage_access_key = env_opt("OBJECT_STORAGE_ACCESS_KEY");
    let object_storage_secret_key = env_opt("OBJECT_STORAGE_SECRET_KEY");
    let object_storage_force_path_style = env_bool("OBJECT_STORAGE_FORCE_PATH_STYLE", true);
    let object_storage_tls_verify = env_bool("OBJECT_STORAGE_TLS_VERIFY", false);
    let object_storage_presign_expire_seconds = env_parse("OBJECT_STORAGE_PRESIGN_EXPIRE_SECONDS", 900u64);
    let blob_storage_dir = env_first_str(&["BLOB_STORAGE_DIR", "OBJECT_STORAGE_LOCAL_DIR"], "./data/objects");
    let jwt_secret = env_str("JWT_SECRET", "documind-dev-secret-change-me");
    let auth_token_expire_hours = env_first_parse(&["AUTH_TOKEN_EXPIRE_HOURS", "JWT_EXPIRE_HOURS"], 24i64);
    let legacy_portal_auth =
        env_bool("PORTAL_MANAGED", false) && env_bool("PORTAL_AUTH_ENABLED", false);
    let auth_login_mode =
        normalize_auth_login_mode(&env::var("AUTH_LOGIN_MODE").unwrap_or_else(|_| {
            if legacy_portal_auth { "portal".to_string() } else { "local".to_string() }
        }));
    let portal_base_url = env_str("PORTAL_BASE_URL", "http://localhost:8080");
    let portal_exchange_endpoint = env_str("PORTAL_EXCHANGE_ENDPOINT", "/api/auth/exchange-ticket");

    let default_tenant_id = env_uuid("DEFAULT_TENANT_ID", "00000000-0000-0000-0000-000000000001");
    let default_user_id = env_uuid("DEFAULT_USER_ID", "00000000-0000-0000-0000-000000000002");
    let default_role = env_str("DEFAULT_ROLE", "enterprise_admin");
    let default_tenant_name = env_str("DEFAULT_TENANT_NAME", "Acme Corp");
    let default_tenant_slug = env_str("DEFAULT_TENANT_SLUG", "acme");
    let super_admin_user_id = env_uuid("SUPER_ADMIN_USER_ID", "00000000-0000-0000-0000-000000000003");
    let standard_user_id = env_uuid("STANDARD_USER_ID", "00000000-0000-0000-0000-000000000004");
    let super_admin_email = env_str("SUPER_ADMIN_EMAIL", "Anner");
    let super_admin_password = env_str("SUPER_ADMIN_PASSWORD", "1");
    let enterprise_admin_email = env_str("ENTERPRISE_ADMIN_EMAIL", "admin@documind.local");
    let enterprise_admin_password = env_str("ENTERPRISE_ADMIN_PASSWORD", "documind123");
    let standard_user_email = env_str("STANDARD_USER_EMAIL", "user@documind.local");
    let standard_user_password = env_str("STANDARD_USER_PASSWORD", "documind123");

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
            enabled: env_parse("RAG_REWRITE_ENABLED", true),
            hyde_enabled: env_parse("RAG_HYDE_ENABLED", true),
            model: env_str("RAG_REWRITE_MODEL", "qwen-turbo"),
        },
        retrieval: RetrievalConfig {
            dense_top_k: env_parse("RAG_DENSE_TOP_K", 100usize),
            bm25_top_k: env_parse("RAG_BM25_TOP_K", 100usize),
            rrf_top_k: env_parse("RAG_RRF_TOP_K", 20usize),
            effective_top_k: env_parse("RAG_TOP_K", 5usize),
        },
        rerank: RerankConfig {
            enabled: env_parse("RAG_RERANK_ENABLED", true),
            provider: env_str("RAG_RERANK_PROVIDER", "dashscope"),
            model: env_str("RAG_RERANK_MODEL", "gte-rerank-v2"),
            api_url: env_nonempty("RAG_RERANK_API_URL"),
            api_key: env_nonempty("RAG_RERANK_API_KEY"),
        },
        embedding: EmbeddingConfig {
            model: env_first_str(&["EMBED_MODEL", "EMBEDDING_MODEL"], "text-embedding-v3"),
            base_url: env_first_str(&["EMBED_BASE_URL", "EMBEDDING_API_URL", "LLM_BASE_URL"], "http://localhost:11434/v1"),
            api_key: env_first_nonempty(&["EMBED_API_KEY", "LLM_API", "LLM_API_KEY"]),
            batch_size: env_first_parse(&["EMBED_BATCH_SIZE", "EMBEDDING_BATCH_SIZE"], 10usize),
            dimension: env_first_parse(&["EMBED_DIM", "EMBEDDING_DIM"], 1024usize),
            retry_max: env_first_parse(&["EMBED_RETRY_MAX", "EMBEDDING_RETRY_MAX"], 3i32),
            worker_poll_ms: env_parse("EMBED_WORKER_POLL_MS", 1_000u64),
            index_schema_version: env_parse("ES_INDEX_SCHEMA_VERSION", 2u32),
            index_name: env_str("ES_INDEX_CHUNKS", "chunks"),
            index_alias: env_str("ES_INDEX_ALIAS", "chunks_search"),
            enabled: env_bool("EMBED_ENABLED", true),
        },
        generation: GenerationConfig {
            model: env_str("LLM_MODEL", "qwen-turbo"),
            base_url: env_str("LLM_BASE_URL", "http://localhost:11434/v1"),
            api_key: env_first_str(&["LLM_API_KEY", "LLM_API"], "ollama"),
            use_real_llm: env_parse("USE_REAL_LLM", false),
            temperature: env_parse("LLM_TEMPERATURE", 0.2f64),
            max_output_tokens: env_parse("LLM_MAX_OUTPUT_TOKENS", 1200u32),
        },
        citation: CitationConfig {
            require_citation: env_parse("RAG_REQUIRE_CITATION", true),
            verify_claims: env_parse("RAG_VERIFY_CLAIMS", false),
            verify_consensus: env_parse("RAG_VERIFY_CONSENSUS", false),
        },
    };

    let agent = AgentConfig {
        reasoning_model: env_str("AGENT_REASONING_MODEL", &rag.rewrite.model),
        default_tone: env_str("AGENT_DEFAULT_TONE", "concise_warm"),
        proactive_followup: env_parse("AGENT_PROACTIVE_FOLLOWUP", true),
        max_followup_suggestions: env_parse("AGENT_MAX_FOLLOWUP_SUGGESTIONS", 2usize),
        allow_analyst_mode: env_parse("AGENT_ALLOW_ANALYST_MODE", true),
        require_citation_for_analysis: env_parse("AGENT_REQUIRE_CITATION_FOR_ANALYSIS", true),
        clarification_style: env_str("AGENT_CLARIFICATION_STYLE", "short"),
        max_react_steps: env_usize("AGENT_MAX_REACT_STEPS", 4).clamp(2, 8),
        max_queries_per_step: env_usize("AGENT_MAX_QUERIES_PER_STEP", 4).clamp(1, 8),
        max_history_turns: env_usize("AGENT_MAX_HISTORY_TURNS", 12).clamp(1, 50),
        max_history_chars: env_usize("AGENT_MAX_HISTORY_CHARS", 24_000).clamp(2_000, 100_000),
        max_context_chars: env_usize("AGENT_MAX_CONTEXT_CHARS", 30_000).clamp(4_000, 120_000),
        max_repair_attempts: env_usize("AGENT_MAX_REPAIR_ATTEMPTS", 1).clamp(0, 1),
        total_timeout_seconds: env_parse("AGENT_TOTAL_TIMEOUT_SECONDS", 240u64),
    };

    let config = AppConfig {
        environment, server_host, server_port, database_url, redis_url, rabbitmq_url,
        elasticsearch_url, object_storage_provider, object_storage_endpoint, object_storage_region,
        object_storage_bucket, object_storage_access_key, object_storage_secret_key,
        object_storage_force_path_style, object_storage_tls_verify,
        object_storage_presign_expire_seconds, blob_storage_dir, jwt_secret,
        auth_token_expire_hours, auth_login_mode, portal_base_url, portal_exchange_endpoint,
        default_tenant_id, default_user_id, default_role, default_kb_ids, default_tenant_name,
        default_tenant_slug, super_admin_user_id, standard_user_id, super_admin_email,
        super_admin_password, enterprise_admin_email, enterprise_admin_password,
        standard_user_email, standard_user_password, rag, agent,
    };
    config.validate()?;
    Ok(config)
}

impl AppConfig {
    pub fn is_production(&self) -> bool {
        self.environment == RuntimeEnvironment::Production
    }

    fn validate(&self) -> Result<()> {
        if self.rag.embedding.dimension == 0 {
            return Err(anyhow!("EMBED_DIM must be greater than zero"));
        }
        if self.rag.embedding.batch_size == 0 || self.rag.embedding.batch_size > 100 {
            return Err(anyhow!("EMBED_BATCH_SIZE must be between 1 and 100"));
        }
        if self.rag.embedding.retry_max < 1 || self.rag.embedding.retry_max > 20 {
            return Err(anyhow!("EMBED_RETRY_MAX must be between 1 and 20"));
        }
        if !self.is_production() {
            return Ok(());
        }

        let mut missing = vec![];
        if self.database_url.as_deref().is_none_or(str::is_empty) {
            missing.push("DATABASE_URL");
        }
        if self.redis_url.as_deref().is_none_or(str::is_empty) {
            missing.push("REDIS_URL");
        }
        if self.rabbitmq_url.as_deref().is_none_or(str::is_empty) {
            missing.push("RABBITMQ_URL");
        }
        if self.elasticsearch_url.as_deref().is_none_or(str::is_empty) {
            missing.push("ELASTICSEARCH_URL");
        }
        if self
            .object_storage_endpoint
            .as_deref()
            .is_none_or(str::is_empty)
        {
            missing.push("OBJECT_STORAGE_ENDPOINT");
        }
        if self
            .object_storage_access_key
            .as_deref()
            .is_none_or(str::is_empty)
        {
            missing.push("OBJECT_STORAGE_ACCESS_KEY");
        }
        if self
            .object_storage_secret_key
            .as_deref()
            .is_none_or(str::is_empty)
        {
            missing.push("OBJECT_STORAGE_SECRET_KEY");
        }
        if !self.rag.generation.use_real_llm {
            missing.push("USE_REAL_LLM=true");
        }
        if self.rag.generation.api_key.trim().is_empty() || self.rag.generation.api_key == "ollama"
        {
            missing.push("LLM_API_KEY");
        }
        if !self.rag.embedding.enabled {
            missing.push("EMBED_ENABLED=true");
        }
        if self
            .rag
            .embedding
            .api_key
            .as_deref()
            .is_none_or(str::is_empty)
        {
            missing.push("EMBED_API_KEY");
        }
        if !self.rag.rewrite.enabled {
            missing.push("RAG_REWRITE_ENABLED=true");
        }
        if !self.rag.rerank.enabled {
            missing.push("RAG_RERANK_ENABLED=true");
        }
        if self.rag.rerank.api_url.as_deref().is_none_or(str::is_empty) {
            missing.push("RAG_RERANK_API_URL");
        }
        if self.rag.rerank.api_key.as_deref().is_none_or(str::is_empty) {
            missing.push("RAG_RERANK_API_KEY");
        }
        if self.jwt_secret.trim().len() < 32 || self.jwt_secret == "documind-dev-secret-change-me" {
            missing.push("JWT_SECRET>=32");
        }

        if missing.is_empty() {
            Ok(())
        } else {
            Err(anyhow!(
                "production configuration is incomplete: {}",
                missing.join(", ")
            ))
        }
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

fn env_usize(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn normalize_auth_login_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "portal" | "portal_sso" | "portal-managed" | "portal_managed" => "portal".to_string(),
        _ => "local".to_string(),
    }
}
