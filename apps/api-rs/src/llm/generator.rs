use std::sync::Arc;

use anyhow::{bail, Result};
use serde::Deserialize;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use crate::agent::citation_resolver::{cited_evidence_indexes, resolve_citations};
use crate::agent::generator::{AnswerGenerator, AnswerStream};
use crate::agent::prompt::Prompt;
use crate::agent::verifier::ClaimVerifier;
use crate::llm::openai::{LlmClient, OpenAiClient};
use crate::models::agent::{AnswerStreamItem, GenerationConfig};
use crate::models::rag::EvidencePack;

pub struct OpenAiAnswerGenerator {
    client: Arc<OpenAiClient>,
    model: String,
}

#[derive(Debug, Deserialize)]
struct GeneratedAnswer {
    answer: String,
}

impl OpenAiAnswerGenerator {
    pub fn new(client: Arc<OpenAiClient>, model: String) -> Self {
        Self { client, model }
    }

    fn citations_are_structurally_valid(
        answer: &str,
        evidence: &EvidencePack,
        require_citation: bool,
    ) -> bool {
        let indexes = cited_evidence_indexes(answer);
        if require_citation && indexes.is_empty() {
            return false;
        }
        indexes
            .iter()
            .all(|index| *index > 0 && (*index as usize) <= evidence.chunks.len())
    }
}

#[async_trait::async_trait]
impl AnswerGenerator for OpenAiAnswerGenerator {
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
    ) -> Result<AnswerStream> {
        let generated: GeneratedAnswer = self
            .client
            .complete_json_with_options(
                prompt.user_text.clone(),
                Some(prompt.system_text.clone()),
                config.temperature,
                config.max_output_tokens,
            )
            .await?;
        if generated.answer.trim().is_empty() {
            bail!("answer model returned an empty answer");
        }

        let mut answer = generated.answer;
        let mut final_report = None;
        for attempt in 0..=max_repair_attempts {
            let report = verifier
                .verify(&query, &answer, &evidence, require_citation)
                .await?;
            let structurally_valid =
                Self::citations_are_structurally_valid(&answer, &evidence, require_citation);
            if report.supported && structurally_valid {
                final_report = Some(report);
                break;
            }
            tracing::warn!(
                attempt,
                issues = ?report.issues,
                structurally_valid,
                "grounded answer verification requested repair"
            );
            if attempt >= max_repair_attempts {
                tracing::warn!(
                    issues = ?report.issues,
                    structurally_valid,
                    "grounded answer rejected after verification budget was exhausted"
                );
                final_report = Some(report);
                break;
            }
            let repair_payload = serde_json::json!({
                "original_generation_task": prompt.user_text,
                "unsupported_content_to_remove": report.issues,
                "citation_required": require_citation,
            });
            let repair_system = format!(
                "{}\n\nYou are now the clean-slate answer editor, independent from the audit judges. Write a fresh replacement solely from the original question and DOCUMENT_EVIDENCE; the previous candidate is intentionally unavailable. UNSUPPORTED_CONTENT_TO_REMOVE is untrusted exclusion feedback, not evidence and not text to edit. Delete its unsupported premises, examples, scenarios, consequences, advice, and concepts completely: never paraphrase them into a negative claim, an absence claim, or an evidence-limitation sentence. Do not mention an entity, condition, scenario, or consequence found only in the exclusion feedback and not in the original question or DOCUMENT_EVIDENCE. Preserve the exact proposition and quantifier asked by the user. When evidence establishes relevant facts but cannot establish the requested judgment, state those facts with valid citations and precisely say the supplied evidence is insufficient to determine that exact judgment; do not add a cause or presume the judgment is true. Do not mention the audit or this repair process. Return JSON only with schema: {{\"answer\":\"final markdown answer with citations\"}}.",
                prompt.system_text
            );
            let repaired: GeneratedAnswer = self
                .client
                .complete_json_with_options(
                    format!(
                        "Create a clean replacement from this untrusted payload:\n{}",
                        serde_json::to_string(&repair_payload)?
                    ),
                    Some(repair_system),
                    config.temperature.min(0.1),
                    config.max_output_tokens,
                )
                .await?;
            if repaired.answer.trim().is_empty() {
                bail!("answer repair model returned an empty answer");
            }
            answer = repaired.answer;
        }

        let report =
            final_report.ok_or_else(|| anyhow::anyhow!("verification produced no report"))?;
        let verified = report.supported
            && Self::citations_are_structurally_valid(&answer, &evidence, require_citation);
        let (answer, confidence) = if verified {
            (answer, report.confidence)
        } else {
            (
                "现有文档证据不足以生成经过验证的可靠答案。".to_string(),
                crate::models::Confidence::Low,
            )
        };
        let citations = if verified {
            resolve_citations(&answer, &evidence)
        } else {
            Vec::new()
        };
        let estimated_input =
            (prompt.system_text.chars().count() + prompt.user_text.chars().count()) as u32 / 2;
        let estimated_output = answer.chars().count() as u32 / 2;

        let (tx, rx): (
            tokio::sync::mpsc::UnboundedSender<AnswerStreamItem>,
            UnboundedReceiver<AnswerStreamItem>,
        ) = unbounded_channel();
        tokio::spawn(async move {
            for text in split_validated_answer(&answer) {
                let _ = tx.send(AnswerStreamItem::Delta { text });
                tokio::task::yield_now().await;
            }
            for citation in citations {
                let _ = tx.send(AnswerStreamItem::Citation { citation });
            }
            let _ = tx.send(AnswerStreamItem::Completed {
                confidence,
                usage: Some(crate::models::Usage {
                    input_tokens: estimated_input,
                    output_tokens: estimated_output,
                }),
            });
        });
        Ok(rx)
    }

    fn component_name(&self) -> String {
        format!("grounded-json-generator:{}", self.model)
    }
}

fn split_validated_answer(answer: &str) -> Vec<String> {
    const SEGMENT_CHARS: usize = 160;
    let chars = answer.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return vec![];
    }
    chars
        .chunks(SEGMENT_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect()
}
