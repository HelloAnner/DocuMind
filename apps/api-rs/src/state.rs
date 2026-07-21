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
use crate::rag::{
    EmbeddingClientConfig, EsRetriever, HttpReranker, MockReranker, MockRetriever, PgRetriever,
    SimpleContextAssembler,
};
use crate::repositories::{
    AnswerCache, InMemoryAnswerCache, InMemoryConversationRepository, RedisAnswerCache,
    SqlxConversationRepository,
};
use crate::storage::{build_storage, ObjectStorage};
use tracing::warn;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub repository: Arc<dyn crate::repositories::ConversationRepository>,
    pub agent_kernel: AgentKernel,
    pub cache: Arc<dyn AnswerCache>,
    pub db_pool: Option<PgPool>,
    pub redis_client: Option<redis::Client>,
    pub storage: Arc<dyn ObjectStorage>,
}

pub async fn build_state(config: AppConfig) -> Result<AppState> {
    let (repository, db_pool): (
        Arc<dyn crate::repositories::ConversationRepository>,
        Option<PgPool>,
    ) = if let Some(ref url) = config.database_url {
        let pool = sqlx::PgPool::connect(url).await?;
        crate::auth::seed_identity(&pool, &config).await?;
        if let Err(err) = crate::api::documents::recover_interrupted_document_jobs(&pool).await {
            warn!(error = %err, "failed to recover interrupted document jobs");
        }
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

    let embedding_config = config
        .rag
        .embedding
        .enabled
        .then(|| EmbeddingClientConfig::try_from(&config.rag.embedding))
        .transpose()?;
    let retriever: Arc<dyn crate::rag::Retriever> = if let Some(es_url) = &config.elasticsearch_url
    {
        Arc::new(EsRetriever::new(
            es_url.clone(),
            config.rag.embedding.index_alias.clone(),
            embedding_config.clone(),
            config.rag.embedding.model.clone(),
        )?)
    } else if let Some(pool) = &db_pool {
        Arc::new(PgRetriever::new(
            pool.clone(),
            embedding_config,
            config.rag.embedding.model.clone(),
            config.rag.embedding.dimension,
        )?)
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

    let storage = build_storage(&config);

    if let Some(pool) = db_pool.clone() {
        crate::rag::vector_pipeline::start_vector_worker(
            pool,
            config.rag.embedding.clone(),
            config.elasticsearch_url.clone(),
            config.rabbitmq_url.clone(),
        );
    }

    Ok(AppState {
        config,
        repository,
        agent_kernel,
        cache,
        db_pool,
        redis_client,
        storage,
    })
}
