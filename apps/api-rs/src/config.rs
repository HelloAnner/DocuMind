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
    pub model: String,
    pub api_url: Option<String>,
    pub api_key: Option<String>,
    pub min_score: f64,
}

#[derive(Debug, Clone)]
pub struct EmbeddingConfig {
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub batch_size: usize,
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

    let environment = env::var("DOCUMIND_ENV")
        .or_else(|_| env::var("APP_ENV"))
        .or_else(|_| env::var("RUST_ENV"))
        .map(|value| RuntimeEnvironment::from_env_value(&value))
        .unwrap_or(RuntimeEnvironment::Development);
    let server_host = env::var("SERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let server_port = env::var("SERVER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8089);
    let database_url = env::var("DATABASE_URL").ok();
    let redis_url = env::var("REDIS_URL").ok();
    let rabbitmq_url = env::var("RABBITMQ_URL").ok();
    let elasticsearch_url = env::var("ELASTICSEARCH_URL").ok();
    let object_storage_provider =
        env::var("OBJECT_STORAGE_PROVIDER").unwrap_or_else(|_| "minio".to_string());
    let object_storage_endpoint = env::var("OBJECT_STORAGE_ENDPOINT").ok();
    let object_storage_region =
        env::var("OBJECT_STORAGE_REGION").unwrap_or_else(|_| "us-east-1".to_string());
    let object_storage_bucket =
        env::var("OBJECT_STORAGE_BUCKET").unwrap_or_else(|_| "documind".to_string());
    let object_storage_access_key = env::var("OBJECT_STORAGE_ACCESS_KEY").ok();
    let object_storage_secret_key = env::var("OBJECT_STORAGE_SECRET_KEY").ok();
    let object_storage_force_path_style = env_bool("OBJECT_STORAGE_FORCE_PATH_STYLE", true);
    let object_storage_tls_verify = env_bool("OBJECT_STORAGE_TLS_VERIFY", false);
    let object_storage_presign_expire_seconds = env::var("OBJECT_STORAGE_PRESIGN_EXPIRE_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(900);
    let blob_storage_dir = env::var("BLOB_STORAGE_DIR")
        .or_else(|_| env::var("OBJECT_STORAGE_LOCAL_DIR"))
        .unwrap_or_else(|_| "./data/objects".to_string());
    let jwt_secret =
        env::var("JWT_SECRET").unwrap_or_else(|_| "documind-dev-secret-change-me".to_string());
    let auth_token_expire_hours = env::var("AUTH_TOKEN_EXPIRE_HOURS")
        .or_else(|_| env::var("JWT_EXPIRE_HOURS"))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(24);
    let legacy_portal_auth =
        env_bool("PORTAL_MANAGED", false) && env_bool("PORTAL_AUTH_ENABLED", false);
    let auth_login_mode =
        normalize_auth_login_mode(&env::var("AUTH_LOGIN_MODE").unwrap_or_else(|_| {
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
    let super_admin_email = env::var("SUPER_ADMIN_EMAIL").unwrap_or_else(|_| "Anner".to_string());
    let super_admin_password = env::var("SUPER_ADMIN_PASSWORD").unwrap_or_else(|_| "1".to_string());
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
            api_url: env::var("RAG_RERANK_API_URL")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            api_key: env::var("RAG_RERANK_API_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            min_score: env::var("RAG_RERANK_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.3),
        },
        embedding: EmbeddingConfig {
            model: env::var("EMBED_MODEL").unwrap_or_else(|_| "text-embedding-v3".to_string()),
            base_url: env::var("EMBED_BASE_URL")
                .or_else(|_| env::var("LLM_BASE_URL"))
                .unwrap_or_else(|_| "http://localhost:11434/v1".to_string()),
            api_key: env::var("EMBED_API_KEY")
                .or_else(|_| env::var("LLM_API"))
                .or_else(|_| env::var("LLM_API_KEY"))
                .ok()
                .filter(|v| !v.trim().is_empty()),
            batch_size: env::var("EMBED_BATCH_SIZE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            index_name: env::var("ES_INDEX_CHUNKS").unwrap_or_else(|_| "chunks".to_string()),
            index_alias: env::var("ES_INDEX_ALIAS").unwrap_or_else(|_| "chunks_search".to_string()),
            enabled: env_bool("EMBED_ENABLED", true),
        },
        generation: GenerationConfig {
            model: env::var("LLM_MODEL").unwrap_or_else(|_| "qwen-turbo".to_string()),
            base_url: env::var("LLM_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:11434/v1".to_string()),
            api_key: env::var("LLM_API_KEY")
                .or_else(|_| env::var("LLM_API"))
                .unwrap_or_else(|_| "ollama".to_string()),
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

    let config = AppConfig {
        environment,
        server_host,
        server_port,
        database_url,
        redis_url,
        rabbitmq_url,
        elasticsearch_url,
        object_storage_provider,
        object_storage_endpoint,
        object_storage_region,
        object_storage_bucket,
        object_storage_access_key,
        object_storage_secret_key,
        object_storage_force_path_style,
        object_storage_tls_verify,
        object_storage_presign_expire_seconds,
        blob_storage_dir,
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
    };
    config.validate()?;
    Ok(config)
}

impl AppConfig {
    pub fn is_production(&self) -> bool {
        self.environment == RuntimeEnvironment::Production
    }

    fn validate(&self) -> Result<()> {
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

fn normalize_auth_login_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "portal" | "portal_sso" | "portal-managed" | "portal_managed" => "portal".to_string(),
        _ => "local".to_string(),
    }
}
