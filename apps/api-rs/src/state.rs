use std::sync::Arc;

use anyhow::Result;

use crate::agent::{
    AgentKernel, BuiltinPromptRegistry, MockAnswerGenerator, RuleBasedClaimVerifier,
    RuleBasedModeSelector, RuleBasedQueryRewriter, RuleBasedRetrievalPlanner,
};
use crate::config::AppConfig;
use crate::llm::openai::{OpenAiClient, OpenAiClientConfig};
use crate::llm::OpenAiAnswerGenerator;
use crate::rag::{MockReranker, MockRetriever, SimpleContextAssembler};
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
}

pub async fn build_state(config: AppConfig) -> Result<AppState> {
    let repository: Arc<dyn crate::repositories::ConversationRepository> = if let Some(ref url) =
        config.database_url
    {
        let pool = sqlx::PgPool::connect(url).await?;
        Arc::new(SqlxConversationRepository::new(pool))
    } else {
        Arc::new(InMemoryConversationRepository::new())
    };

    let cache: Arc<dyn AnswerCache> = if let Some(ref url) = config.redis_url {
        let client = redis::Client::open(url.as_str())?;
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

    let agent_kernel = AgentKernel::new(
        Arc::new(RuleBasedModeSelector::new()),
        Arc::new(RuleBasedQueryRewriter::new()),
        Arc::new(RuleBasedRetrievalPlanner::new()),
        Arc::new(MockRetriever::new()),
        Arc::new(MockReranker::new()),
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
    })
}
