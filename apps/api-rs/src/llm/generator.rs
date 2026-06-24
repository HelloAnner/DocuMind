use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use crate::agent::generator::{AnswerGenerator, AnswerStream};
use crate::agent::prompt::Prompt;
use crate::agent::verifier::ClaimVerifier;
use crate::llm::openai::{LlmClient, OpenAiClient};
use crate::models::agent::{AnswerStreamItem, CitationOutput, GenerationConfig};
use crate::models::rag::EvidencePack;

pub struct OpenAiAnswerGenerator {
    client: Arc<OpenAiClient>,
}

impl OpenAiAnswerGenerator {
    pub fn new(client: Arc<OpenAiClient>) -> Self {
        Self { client }
    }
}

#[async_trait::async_trait]
impl AnswerGenerator for OpenAiAnswerGenerator {
    async fn generate(
        &self,
        _query: String,
        evidence: EvidencePack,
        prompt: Prompt,
        config: GenerationConfig,
        verifier: Arc<dyn ClaimVerifier>,
    ) -> Result<AnswerStream> {
        let citations: Vec<CitationOutput> = evidence
            .chunks
            .iter()
            .enumerate()
            .map(|(i, c)| CitationOutput {
                index: i as i32 + 1,
                chunk_id: c.chunk.chunk_id,
                doc_id: c.chunk.doc_id,
                doc_title: c.chunk.doc_title.clone(),
                page_range: c.chunk.page_range.clone(),
                quote: c.chunk.content.clone(),
                score: c.score,
                source_status: "available".to_string(),
            })
            .collect();

        let system = Some("你是 DocuMind 的企业文档问答 Agent。".to_string());
        let prompt_text = prompt.full_text.clone();
        let mut text_rx = self
            .client
            .stream_text(
                prompt.full_text,
                system,
                config.temperature,
                config.max_output_tokens,
            )
            .await?;

        let (tx, rx): (
            tokio::sync::mpsc::UnboundedSender<AnswerStreamItem>,
            UnboundedReceiver<AnswerStreamItem>,
        ) = unbounded_channel();
        let evidence_for_verify = evidence.clone();
        let verifier = verifier.clone();

        tokio::spawn(async move {
            let mut full_answer = String::new();
            while let Some(item) = text_rx.recv().await {
                match item {
                    Ok(text) => {
                        full_answer.push_str(&text);
                        let _ = tx.send(AnswerStreamItem::Delta { text });
                    }
                    Err(err) => {
                        let _ = tx.send(AnswerStreamItem::Failed {
                            code: err.code,
                            message: err.message,
                        });
                        return;
                    }
                }
            }

            if full_answer.trim().is_empty() {
                let _ = tx.send(AnswerStreamItem::Failed {
                    code: "LLM_STREAM_ERROR".to_string(),
                    message: "LLM provider finished without returning answer content".to_string(),
                });
                return;
            }

            for citation in citations.clone() {
                let _ = tx.send(AnswerStreamItem::Citation { citation });
            }

            let report = verifier.verify(&full_answer, &evidence_for_verify).await;
            let confidence = report.confidence;
            if !report.issues.is_empty() {
                let note = format!("\n[校验提示] {}", report.issues.join("；"));
                let _ = tx.send(AnswerStreamItem::Delta { text: note });
            }

            let _ = tx.send(AnswerStreamItem::Completed {
                confidence,
                usage: Some(crate::models::Usage {
                    input_tokens: prompt_text.len() as u32 / 4,
                    output_tokens: full_answer.len() as u32 / 4,
                }),
            });
        });

        Ok(rx)
    }
}
