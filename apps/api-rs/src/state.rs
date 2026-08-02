use std::sync::Arc;

use anyhow::Result;
use sqlx::PgPool;

use crate::agent::{
    AgentKernel, AgentModel, AgentToolRegistry, BuiltinPromptRegistry, ClarificationTool,
    GroundedAnswerFinalizer, KnowledgeSearchTool, LlmClaimVerifier, StructuralClaimVerifier,
};
use crate::config::AppConfig;
use crate::llm::openai::{OpenAiClient, OpenAiClientConfig};
use crate::rag::{
    EmbeddingClientConfig, EsRetriever, HttpReranker, RerankProvider, SimpleContextAssembler,
};
use crate::repositories::{InMemoryConversationRepository, SqlxConversationRepository};
use crate::storage::{build_storage, ObjectStorage};
use tracing::warn;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub repository: Arc<dyn crate::repositories::ConversationRepository>,
    pub agent_kernel: AgentKernel,
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
    let agent_model: Arc<dyn AgentModel> = generation_client;
    let verifier: Arc<dyn crate::agent::ClaimVerifier> = if config.rag.citation.verify_claims {
        Arc::new(LlmClaimVerifier::new(
            reasoning_client,
            config.agent.reasoning_model.clone(),
            config.rag.citation.verify_consensus,
        ))
    } else {
        Arc::new(StructuralClaimVerifier)
    };

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

    let tools = AgentToolRegistry::new(vec![
        Arc::new(KnowledgeSearchTool::new(retriever, reranker)),
        Arc::new(ClarificationTool),
    ])?;
    let agent_kernel = AgentKernel::new(
        agent_model,
        tools,
        Arc::new(SimpleContextAssembler::new()),
        Arc::new(BuiltinPromptRegistry::new()),
        Arc::new(GroundedAnswerFinalizer::new(verifier)),
    )?;

    let storage = build_storage(&config);

    if let Some(pool) = db_pool.clone() {
        crate::rag::vector_pipeline::start_vector_worker(
            pool,
            config.rag.embedding.clone(),
            config.elasticsearch_url.clone(),
            config.rabbitmq_url.clone(),
        );
    }

    let state = AppState {
        config,
        repository,
        agent_kernel,
        db_pool,
        redis_client,
        storage,
    };
    let resumed = crate::api::documents::resume_pending_document_jobs(&state)
        .await
        .map_err(|error| anyhow::anyhow!("failed to resume document jobs: {error:?}"))?;
    if resumed > 0 {
        warn!(resumed, "resumed pending document jobs");
    }
    Ok(state)
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
