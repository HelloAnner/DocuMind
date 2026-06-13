use std::sync::Arc;

use anyhow::Result;

use crate::agent::{
    AgentKernel, BuiltinPromptRegistry, MockAnswerGenerator, RuleBasedClaimVerifier,
    RuleBasedModeSelector, RuleBasedQueryRewriter, RuleBasedRetrievalPlanner,
};
use crate::config::AppConfig;
use crate::rag::{MockReranker, MockRetriever, SimpleContextAssembler};
use crate::repositories::{AnswerCache, InMemoryAnswerCache, InMemoryConversationRepository};

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub repository: Arc<dyn crate::repositories::ConversationRepository>,
    pub agent_kernel: AgentKernel,
    pub cache: Arc<dyn AnswerCache>,
}

pub fn build_state(config: AppConfig) -> Result<AppState> {
    let repository: Arc<dyn crate::repositories::ConversationRepository> =
        Arc::new(InMemoryConversationRepository::new());
    let cache: Arc<dyn AnswerCache> = Arc::new(InMemoryAnswerCache::new());

    let agent_kernel = AgentKernel::new(
        Arc::new(RuleBasedModeSelector::new()),
        Arc::new(RuleBasedQueryRewriter::new()),
        Arc::new(RuleBasedRetrievalPlanner::new()),
        Arc::new(MockRetriever::new()),
        Arc::new(MockReranker::new()),
        Arc::new(SimpleContextAssembler::new()),
        Arc::new(MockAnswerGenerator::new()),
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
