use std::sync::Arc;

use anyhow::Result;
use sqlx::PgPool;

use crate::agent::{
    AgentKernel, BuiltinPromptRegistry, MockAnswerGenerator, RuleBasedClaimVerifier,
    RuleBasedModeSelector, RuleBasedQueryRewriter, RuleBasedRetrievalPlanner,
};
use crate::config::AppConfig;
use crate::llm::openai::{OpenAiClient, OpenAiClientConfig};
use crate::llm::OpenAiAnswerGenerator;
use crate::rag::{HttpReranker, MockReranker, MockRetriever, PgRetriever, SimpleContextAssembler};
use crate::repositories::{
    AnswerCache, InMemoryAnswerCache, InMemoryConversationRepository, RedisAnswerCache,
    SqlxConversationRepository,
};

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub repository: Arc<dyn crate::repositories::ConversationRepository>,
    pub agent_kernel: AgentKernel,
    pub cache: Arc<dyn AnswerCache>,
    pub db_pool: Option<PgPool>,
    pub redis_client: Option<redis::Client>,
}

pub async fn build_state(config: AppConfig) -> Result<AppState> {
    let (repository, db_pool): (
        Arc<dyn crate::repositories::ConversationRepository>,
        Option<PgPool>,
    ) = if let Some(ref url) = config.database_url {
        let pool = sqlx::PgPool::connect(url).await?;
        crate::auth::seed_identity(&pool, &config).await?;
        (
            Arc::new(SqlxConversationRepository::new(pool.clone())),
            Some(pool),
        )
    } else {
        (Arc::new(InMemoryConversationRepository::new()), None)
    };

    let redis_client = if let Some(ref url) = config.redis_url {
        Some(redis::Client::open(url.as_str())?)
    } else {
        None
    };

    let cache: Arc<dyn AnswerCache> = if let Some(client) = redis_client.clone() {
        Arc::new(RedisAnswerCache::new(client))
    } else {
        Arc::new(InMemoryAnswerCache::new())
    };

    let answer_generator: Arc<dyn crate::agent::generator::AnswerGenerator> =
        if config.rag.generation.use_real_llm {
            let llm_config = OpenAiClientConfig {
                base_url: config.rag.generation.base_url.clone(),
                api_key: config.rag.generation.api_key.clone(),
                model: config.rag.generation.model.clone(),
                timeout_seconds: 120,
            };
            let client = std::sync::Arc::new(OpenAiClient::new(llm_config)?);
            Arc::new(OpenAiAnswerGenerator::new(client))
        } else {
            Arc::new(MockAnswerGenerator::new())
        };

    let retriever: Arc<dyn crate::rag::Retriever> = if let Some(pool) = &db_pool {
        Arc::new(PgRetriever::new(pool.clone()))
    } else {
        Arc::new(MockRetriever::new())
    };

    let reranker: Arc<dyn crate::rag::Reranker> = if config.rag.rerank.enabled {
        if let Some(api_url) = &config.rag.rerank.api_url {
            Arc::new(HttpReranker::new(
                api_url.clone(),
                config.rag.rerank.api_key.clone(),
                config.rag.rerank.model.clone(),
            )?)
        } else {
            Arc::new(MockReranker::new())
        }
    } else {
        Arc::new(MockReranker::new())
    };

    let agent_kernel = AgentKernel::new(
        Arc::new(RuleBasedModeSelector::new()),
        Arc::new(RuleBasedQueryRewriter::new()),
        Arc::new(RuleBasedRetrievalPlanner::new()),
        retriever,
        reranker,
        Arc::new(SimpleContextAssembler::new()),
        answer_generator,
        Arc::new(BuiltinPromptRegistry::new()),
        Arc::new(RuleBasedClaimVerifier::new()),
    );

    Ok(AppState {
        config,
        repository,
        agent_kernel,
        cache,
        db_pool,
        redis_client,
    })
}
