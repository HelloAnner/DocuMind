use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc::unbounded_channel;

use crate::models::agent::{
    AgentRequest, AgentRun, AgentTrace, AnswerStreamItem, ConversationTurn, PromptVersions,
};
use crate::models::now;
use crate::models::rag::{ContextInput, EvidencePack, RerankInput, RetrievalInput};
use crate::models::trace::{PlanMode, RetrievalPlan, SubQuery};
use crate::models::{Confidence, Usage};

use super::generator::{AnswerGenerator, AnswerStream};
use super::mode::ModeSelector;
use super::planner::RetrievalPlanner;
use super::prompt::PromptRegistry;
use super::rewriter::QueryRewriter;
use super::verifier::ClaimVerifier;
use crate::rag::{ContextAssembler, Reranker, Retriever};

#[derive(Clone)]
pub struct AgentKernel {
    pub mode_selector: Arc<dyn ModeSelector>,
    pub query_rewriter: Arc<dyn QueryRewriter>,
    pub retrieval_planner: Arc<dyn RetrievalPlanner>,
    pub retriever: Arc<dyn Retriever>,
    pub reranker: Arc<dyn Reranker>,
    pub context_assembler: Arc<dyn ContextAssembler>,
    pub answer_generator: Arc<dyn AnswerGenerator>,
    pub prompt_registry: Arc<dyn PromptRegistry>,
    pub claim_verifier: Arc<dyn ClaimVerifier>,
}

impl AgentKernel {
    pub fn new(
        mode_selector: Arc<dyn ModeSelector>,
        query_rewriter: Arc<dyn QueryRewriter>,
        retrieval_planner: Arc<dyn RetrievalPlanner>,
        retriever: Arc<dyn Retriever>,
        reranker: Arc<dyn Reranker>,
        context_assembler: Arc<dyn ContextAssembler>,
        answer_generator: Arc<dyn AnswerGenerator>,
        prompt_registry: Arc<dyn PromptRegistry>,
        claim_verifier: Arc<dyn ClaimVerifier>,
    ) -> Self {
        Self {
            mode_selector,
            query_rewriter,
            retrieval_planner,
            retriever,
            reranker,
            context_assembler,
            answer_generator,
            prompt_registry,
            claim_verifier,
        }
    }

    pub async fn run(&self, req: AgentRequest) -> Result<AgentRun> {
        let mode = match req.options.mode {
            Some(m) => m,
            None => {
                self.mode_selector
                    .select(&req.original_query, &req.history)
                    .await?
            }
        };

        let rewrite = self
            .query_rewriter
            .rewrite(&req.original_query, &req.history, &req.effective_kb_ids)
            .await?;

        let mut plan = RetrievalPlan {
            mode: PlanMode::Single,
            queries: vec![SubQuery {
                query: rewrite.rewritten_query.clone(),
                reason: "default single query".to_string(),
            }],
        };

        let reranked: Vec<crate::models::rag::RerankedChunk>;
        let evidence: EvidencePack;

        let answer_stream: AnswerStream;
        let mode_reason: String;

        if rewrite.needs_clarification {
            mode_reason = "pronoun unclear or scope ambiguous".to_string();
            let q = rewrite
                .clarification_question
                .clone()
                .unwrap_or_else(|| "能再具体说明一下吗？".to_string());
            answer_stream =
                single_text_stream(q, Confidence::Low, Some(NoAnswerReason::NeedsClarification));
        } else {
            plan = self
                .retrieval_planner
                .plan(&req.original_query, &rewrite)
                .await?;

            let queries: Vec<String> = plan.queries.iter().map(|q| q.query.clone()).collect();
            let retrieved = self
                .retriever
                .retrieve(RetrievalInput {
                    tenant_id: req.tenant_id,
                    effective_kb_ids: req.effective_kb_ids.clone(),
                    queries,
                    top_k: 10,
                })
                .await?;

            reranked = self
                .reranker
                .rerank(RerankInput {
                    query: rewrite.rewritten_query.clone(),
                    chunks: retrieved,
                    top_k: 5,
                })
                .await?;

            let max_score = reranked.iter().map(|r| r.score).fold(0.0, f64::max);
            let threshold = 0.3;

            if reranked.is_empty() || max_score < threshold {
                mode_reason = "no relevant chunks above threshold".to_string();
                answer_stream = single_text_stream(
                    "文档中未找到与该问题直接相关的信息。".to_string(),
                    Confidence::Low,
                    Some(NoAnswerReason::NoRelevantChunks),
                );
            } else {
                mode_reason = format!("selected mode {mode} based on query intent");
                evidence = self
                    .context_assembler
                    .assemble(ContextInput {
                        chunks: reranked.clone(),
                        original_query: req.original_query.clone(),
                    })
                    .await?;

                let history_text = format_history(&req.history);
                let prompt = self
                    .prompt_registry
                    .compose(
                        mode,
                        &req.original_query,
                        Some(&rewrite.rewritten_query),
                        &history_text,
                        &evidence,
                        &req.options,
                    )
                    .await?;

                answer_stream = self
                    .answer_generator
                    .generate(
                        req.original_query.clone(),
                        evidence.clone(),
                        prompt,
                        req.options.generation.clone(),
                        self.claim_verifier.clone(),
                    )
                    .await?;
            }
        }

        let prompt_versions = PromptVersions {
            persona: "persona-v1".to_string(),
            guardrail: "grounded-guardrail-v1".to_string(),
            mode: format!("mode-{mode}-v1"),
            task: "grounded-task-v1".to_string(),
        };

        let trace = AgentTrace {
            mode_reason,
            rewritten_query: Some(rewrite.rewritten_query.clone()),
            keywords: rewrite.keywords.clone(),
            resolved_refs: rewrite.resolved_refs.clone(),
            retrieval_plan: plan.clone(),
            prompt_versions,
            model: req.options.generation.model.clone(),
            usage: Some(Usage {
                input_tokens: 0,
                output_tokens: 0,
            }),
            started_at: now(),
        };

        Ok(AgentRun {
            assistant_message_id: req.assistant_message_id,
            mode,
            rewritten_query: Some(rewrite.rewritten_query),
            retrieval_plan: plan,
            answer_stream,
            trace,
        })
    }
}

fn single_text_stream(
    text: String,
    confidence: Confidence,
    _reason: Option<NoAnswerReason>,
) -> AnswerStream {
    let (tx, rx) = unbounded_channel();
    tokio::spawn(async move {
        for segment in split_text(&text) {
            let _ = tx.send(AnswerStreamItem::Delta { text: segment });
        }
        let _ = tx.send(AnswerStreamItem::Completed {
            confidence,
            usage: Some(Usage {
                input_tokens: 0,
                output_tokens: text.len() as u32,
            }),
        });
    });
    rx
}

fn split_text(text: &str) -> Vec<String> {
    let mut segments = vec![];
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if ch == '。' || ch == '；' || ch == '？' || ch == '！' {
            segments.push(current.clone());
            current.clear();
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    if segments.is_empty() {
        segments.push(text.to_string());
    }
    segments
}

fn format_history(history: &[ConversationTurn]) -> String {
    history
        .iter()
        .map(|t| format!("用户：{}\n助手：{}", t.user_message, t.assistant_answer))
        .collect::<Vec<_>>()
        .join("\n\n")
}

use crate::models::NoAnswerReason;
