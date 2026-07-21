use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::agent::prompt::Prompt;
use crate::agent::verifier::ClaimVerifier;
use crate::models::agent::{AnswerStreamItem, GenerationConfig};
use crate::models::rag::EvidencePack;

pub type AnswerStream = UnboundedReceiver<AnswerStreamItem>;

#[async_trait::async_trait]
pub trait AnswerGenerator: Send + Sync {
    #[allow(clippy::too_many_arguments)]
    async fn generate(
        &self,
        query: String,
        evidence: EvidencePack,
        prompt: Prompt,
        config: GenerationConfig,
        verifier: Arc<dyn ClaimVerifier>,
        require_citation: bool,
        max_repair_attempts: usize,
    ) -> Result<AnswerStream>;

    fn component_name(&self) -> String;
}
