use anyhow::{bail, Result};
use serde::Deserialize;

use super::{AgentTool, TerminalToolEffect, ToolEffect, ToolExecution, ToolExecutionContext};
use crate::agent::model::{AgentToolCall, AgentToolDefinition};
use crate::models::agent::AgentMode;
use crate::models::{Confidence, NoAnswerReason};

pub struct ClarificationTool;

#[derive(Debug, Deserialize)]
struct ClarificationArguments {
    question: String,
    reason: String,
}

#[async_trait::async_trait]
impl AgentTool for ClarificationTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "ask_clarification".to_string(),
            description: "Pause and ask one precise question when the user's intent is genuinely ambiguous. Do not use this for missing evidence or uncertain corpus contents.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "One concise user-facing clarification question."
                    },
                    "reason": {
                        "type": "string",
                        "description": "Brief operational reason; do not expose hidden reasoning."
                    }
                },
                "required": ["question", "reason"]
            }),
        }
    }

    async fn execute(
        &self,
        call: &AgentToolCall,
        _context: &ToolExecutionContext<'_>,
    ) -> Result<ToolExecution> {
        let arguments: ClarificationArguments = serde_json::from_str(&call.arguments_json)?;
        let question = arguments.question.trim().to_string();
        if question.is_empty() {
            bail!("ask_clarification requires a non-empty question");
        }
        Ok(ToolExecution {
            public_result: serde_json::json!({
                "question": question,
                "reason": arguments.reason,
                "status": "waiting_for_user"
            }),
            model_result: serde_json::json!({
                "status": "waiting_for_user",
                "question": question
            }),
            effect: ToolEffect::Terminal(TerminalToolEffect {
                answer: question,
                mode: AgentMode::Clarifier,
                confidence: Confidence::Low,
                no_answer_reason: Some(NoAnswerReason::NeedsClarification),
            }),
        })
    }

    fn component_name(&self) -> String {
        "builtin-ask-clarification-v1".to_string()
    }
}
