use std::env;

use anyhow::Result;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub server_host: String,
    pub server_port: u16,
    pub default_tenant_id: Uuid,
    pub default_user_id: Uuid,
    pub default_role: String,
    pub default_kb_ids: Vec<Uuid>,
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

    let default_tenant_id = env::var("DEFAULT_TENANT_ID")
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .unwrap_or_else(|| Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap());

    let default_user_id = env::var("DEFAULT_USER_ID")
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .unwrap_or_else(|| Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap());

    let default_role = env::var("DEFAULT_ROLE").unwrap_or_else(|_| "tenant_admin".to_string());

    let default_kb_ids: Vec<Uuid> = env::var("DEFAULT_KB_IDS")
        .ok()
        .map(|v| {
            v.split(',')
                .filter_map(|s| Uuid::parse_str(s.trim()).ok())
                .collect()
        })
        .unwrap_or_else(|| {
            vec![Uuid::parse_str("00000000-0000-0000-0000-000000000003").unwrap()]
        });

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
        default_tone: env::var("AGENT_DEFAULT_TONE")
            .unwrap_or_else(|_| "concise_warm".to_string()),
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
        default_tenant_id,
        default_user_id,
        default_role,
        default_kb_ids,
        rag,
        agent,
    })
}
