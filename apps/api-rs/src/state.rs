use std::sync::Arc;

use anyhow::Result;
use sqlx::PgPool;

use crate::agent::{AgentKernel, BuiltinPromptRegistry, LlmAgentReasoner, LlmClaimVerifier};
use crate::config::AppConfig;
use crate::llm::openai::{OpenAiClient, OpenAiClientConfig};
use crate::llm::OpenAiAnswerGenerator;
use crate::rag::{
    EmbeddingClientConfig, EsRetriever, HttpReranker, RerankProvider, SimpleContextAssembler,
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
        recover_interrupted_agent_runs(&pool).await?;
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

    if !config.rag.generation.use_real_llm {
        anyhow::bail!(
            "DocuMind Agent requires USE_REAL_LLM=true; rule-based answer fallback was removed"
        );
    }
    let generation_client = Arc::new(OpenAiClient::new(OpenAiClientConfig {
        base_url: config.rag.generation.base_url.clone(),
        api_key: config.rag.generation.api_key.clone(),
        model: config.rag.generation.model.clone(),
        timeout_seconds: 120,
    })?);
    let reasoning_client = Arc::new(OpenAiClient::new(OpenAiClientConfig {
        base_url: config.rag.generation.base_url.clone(),
        api_key: config.rag.generation.api_key.clone(),
        model: config.agent.reasoning_model.clone(),
        timeout_seconds: 120,
    })?);
    let answer_generator: Arc<dyn crate::agent::generator::AnswerGenerator> = Arc::new(
        OpenAiAnswerGenerator::new(generation_client, config.rag.generation.model.clone()),
    );
    let reasoner: Arc<dyn crate::agent::AgentReasoner> = Arc::new(LlmAgentReasoner::new(
        reasoning_client.clone(),
        config.agent.reasoning_model.clone(),
    ));
    let verifier: Arc<dyn crate::agent::ClaimVerifier> = Arc::new(LlmClaimVerifier::new(
        reasoning_client,
        config.agent.reasoning_model.clone(),
    ));

    if !config.rag.embedding.enabled {
        anyhow::bail!("DocuMind Agent requires EMBED_ENABLED=true");
    }
    let es_url = config
        .elasticsearch_url
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("DocuMind Agent requires ELASTICSEARCH_URL"))?;
    let embedding_config = EmbeddingClientConfig::try_from(&config.rag.embedding)?;
    let retriever: Arc<dyn crate::rag::Retriever> = Arc::new(EsRetriever::new(
        es_url.clone(),
        config.rag.embedding.index_alias.clone(),
        embedding_config,
        config.rag.embedding.model.clone(),
    )?);

    if !config.rag.rerank.enabled {
        anyhow::bail!(
            "DocuMind Agent requires RAG_RERANK_ENABLED=true; rule-based reranking was removed"
        );
    }
    let rerank_url = config
        .rag
        .rerank
        .api_url
        .clone()
        .ok_or_else(|| anyhow::anyhow!("RAG_RERANK_API_URL is required"))?;
    let reranker_adapter = HttpReranker::new(
        rerank_url,
        config.rag.rerank.api_key.clone(),
        config.rag.rerank.model.clone(),
        RerankProvider::parse(&config.rag.rerank.provider)?,
    )?;
    reranker_adapter
        .probe()
        .await
        .map_err(|error| anyhow::anyhow!("reranker readiness probe failed: {error}"))?;
    let reranker: Arc<dyn crate::rag::Reranker> = Arc::new(reranker_adapter);

    let agent_kernel = AgentKernel::new(
        reasoner,
        retriever,
        reranker,
        Arc::new(SimpleContextAssembler::new()),
        answer_generator,
        Arc::new(BuiltinPromptRegistry::new()),
        verifier,
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

async fn recover_interrupted_agent_runs(pool: &PgPool) -> Result<()> {
    let recovered = sqlx::query(
        "UPDATE conversation_messages
         SET status = 'failed',
             error_code = 'EXECUTION_INTERRUPTED',
             error_message = 'Agent execution was interrupted before completion; retry this message.',
             completed_at = NOW()
         WHERE role = 'assistant' AND status = 'answering'",
    )
    .execute(pool)
    .await?
    .rows_affected();
    if recovered > 0 {
        warn!(recovered, "recovered interrupted agent messages");
    }
    Ok(())
}
