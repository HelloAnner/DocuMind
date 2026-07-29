mod conversation;
mod grounding;
mod identity;
mod response;
mod security;
mod tool_policy;

use anyhow::Result;

use crate::models::agent::AgentOptions;

#[derive(Debug, Clone)]
pub struct Prompt {
    pub system_text: String,
    pub persona_version: String,
    pub guardrail_version: String,
    pub mode_version: String,
    pub task_version: String,
}

#[async_trait::async_trait]
pub trait PromptRegistry: Send + Sync {
    async fn compose(&self, options: &AgentOptions) -> Result<Prompt>;
}

pub struct BuiltinPromptRegistry;

impl BuiltinPromptRegistry {
    pub fn new() -> Self {
        Self
    }
}

impl Default for BuiltinPromptRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl PromptRegistry for BuiltinPromptRegistry {
    async fn compose(&self, options: &AgentOptions) -> Result<Prompt> {
        let sections = [
            identity::render(),
            conversation::render(),
            tool_policy::render(options),
            grounding::render(options),
            response::render(options),
            security::render(),
        ];
        Ok(Prompt {
            system_text: sections.join("\n\n"),
            persona_version: "persona-v4".to_string(),
            guardrail_version: "adaptive-grounding-v20".to_string(),
            mode_version: "semantic-mode-autonomous-v20".to_string(),
            task_version: "native-tool-react-v20".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{BuiltinPromptRegistry, PromptRegistry};
    use crate::models::agent::AgentOptions;

    #[tokio::test]
    async fn prompt_keeps_tools_optional_and_document_claims_grounded() {
        let prompt = BuiltinPromptRegistry::new()
            .compose(&AgentOptions::default())
            .await
            .expect("prompt should compose");
        assert!(prompt.system_text.contains("Do not call a tool"));
        assert!(prompt.system_text.contains("knowledge_search"));
        assert!(prompt.system_text.contains("cite"));
        assert!(prompt.system_text.contains("current user message"));
    }
}
