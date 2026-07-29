use std::sync::Arc;

use anyhow::{bail, Result};
use serde::Deserialize;

use super::{AgentTool, KnowledgeSearchEffect, ToolEffect, ToolExecution, ToolExecutionContext};
use crate::agent::events::{emit, AgentProgress};
use crate::agent::model::{AgentToolCall, AgentToolDefinition};
use crate::agent::trace_builder::{reranked_traces, retrieved_traces};
use crate::models::agent::AgentMode;
use crate::models::rag::{RerankInput, RetrievalInput};
use crate::models::trace::{ResolvedRef, SubQuery};
use crate::rag::{Reranker, Retriever};

pub struct KnowledgeSearchTool {
    retriever: Arc<dyn Retriever>,
    reranker: Arc<dyn Reranker>,
}

impl KnowledgeSearchTool {
    pub fn new(retriever: Arc<dyn Retriever>, reranker: Arc<dyn Reranker>) -> Self {
        Self {
            retriever,
            reranker,
        }
    }
}

#[derive(Debug, Deserialize)]
struct KnowledgeSearchArguments {
    queries: Vec<String>,
    rerank_query: String,
    #[serde(default)]
    hypothetical_answer: Option<String>,
    #[serde(default)]
    response_mode: Option<AgentMode>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    resolved_references: Vec<ResolvedReferenceArgument>,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ResolvedReferenceArgument {
    text: String,
    resolved_to: String,
}

#[async_trait::async_trait]
impl AgentTool for KnowledgeSearchTool {
    fn definition(&self) -> AgentToolDefinition {
        AgentToolDefinition {
            name: "knowledge_search".to_string(),
            description: "Search only the user's authorized DocuMind knowledge bases, then rerank and return stable evidence ids for grounded answers. Use for organization-specific document facts, policies, contracts, records, summaries, comparisons, navigation, analysis, and review.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "queries": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "description": "Self-contained semantic queries covering only requested facts."
                    },
                    "rerank_query": {
                        "type": "string",
                        "description": "Self-contained query used to rerank the combined results."
                    },
                    "hypothetical_answer": {
                        "type": "string",
                        "description": "Optional HyDE retrieval aid. It is never evidence."
                    },
                    "response_mode": {
                        "type": "string",
                        "enum": ["answerer", "summarizer", "comparer", "analyst", "navigator", "reviewer"],
                        "description": "Optional semantic response style for the final answer."
                    },
                    "keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional concise search terms for the query trace."
                    },
                    "resolved_references": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "text": {"type": "string"},
                                "resolved_to": {"type": "string"}
                            },
                            "required": ["text", "resolved_to"]
                        },
                        "description": "Optional unambiguous references resolved from conversation history."
                    },
                    "reason": {
                        "type": "string",
                        "description": "Brief operational search purpose without hidden reasoning."
                    }
                },
                "required": ["queries", "rerank_query", "reason"]
            }),
        }
    }

    async fn execute(
        &self,
        call: &AgentToolCall,
        context: &ToolExecutionContext<'_>,
    ) -> Result<ToolExecution> {
        let mut arguments: KnowledgeSearchArguments = serde_json::from_str(&call.arguments_json)?;
        arguments.queries.retain(|query| !query.trim().is_empty());
        arguments
            .queries
            .truncate(context.request.options.runtime.max_queries_per_step.max(1));
        if arguments.queries.is_empty() {
            bail!("knowledge_search requires at least one non-empty query");
        }
        if arguments.rerank_query.trim().is_empty() {
            bail!("knowledge_search requires a non-empty rerank_query");
        }
        if arguments.response_mode == Some(AgentMode::Analyst)
            && !context.request.options.allow_analyst_mode
        {
            bail!("analyst response mode is disabled for this request");
        }

        emit(
            context.progress,
            AgentProgress::StatusUpdated {
                status: "retrieving",
            },
        );
        let retrieval = self
            .retriever
            .retrieve(RetrievalInput {
                tenant_id: context.request.tenant_id,
                effective_kb_ids: context.request.effective_kb_ids.clone(),
                queries: arguments.queries.clone(),
                hypothetical_answer: context
                    .request
                    .options
                    .runtime
                    .hyde_enabled
                    .then_some(arguments.hypothetical_answer.clone())
                    .flatten(),
                top_k: context.request.options.retrieval.rrf_top_k.max(1),
                dense_top_k: context.request.options.retrieval.dense_top_k.max(1),
                bm25_top_k: context.request.options.retrieval.bm25_top_k.max(1),
            })
            .await?;
        let warnings = retrieval.warnings;
        let retrieved = retrieval.chunks;
        let retrieved_chunk_ids = retrieved
            .iter()
            .map(|item| item.chunk_id)
            .collect::<Vec<_>>();
        let mut traces = retrieved_traces(context.request.user_message_id, &retrieved);
        emit(
            context.progress,
            AgentProgress::RetrievalCompleted {
                chunk_count: retrieved.len(),
                warnings: warnings.clone(),
            },
        );

        emit(
            context.progress,
            AgentProgress::StatusUpdated {
                status: "reranking",
            },
        );
        let reranked = self
            .reranker
            .rerank(RerankInput {
                query: arguments.rerank_query.clone(),
                chunks: retrieved,
                top_k: context.request.options.retrieval.rerank_top_k.max(1),
            })
            .await?;
        traces.extend(reranked_traces(context.request.user_message_id, &reranked));
        let top_chunk_ids = reranked
            .iter()
            .map(|item| item.chunk.chunk_id)
            .collect::<Vec<_>>();
        emit(
            context.progress,
            AgentProgress::RerankCompleted {
                top_chunk_ids: top_chunk_ids.clone(),
            },
        );

        let queries = arguments
            .queries
            .iter()
            .map(|query| SubQuery {
                query: query.clone(),
                reason: arguments.reason.clone(),
            })
            .collect();
        let resolved_refs = arguments
            .resolved_references
            .into_iter()
            .filter(|item| !item.text.trim().is_empty() && !item.resolved_to.trim().is_empty())
            .map(|item| ResolvedRef {
                text: item.text,
                resolved_to: item.resolved_to,
                source_message_id: None,
                evidence_message_id: None,
            })
            .collect();
        Ok(ToolExecution {
            public_result: serde_json::json!({
                "retrieved_chunk_count": top_chunk_ids.len(),
                "top_chunk_ids": top_chunk_ids,
                "warnings": warnings.clone()
            }),
            model_result: serde_json::json!({
                "status": "evidence_ready",
                "message": "Evidence ids are assigned by the runtime."
            }),
            effect: ToolEffect::KnowledgeSearch(KnowledgeSearchEffect {
                chunks: reranked,
                retrieval_traces: traces,
                retrieved_chunk_ids,
                queries,
                rerank_query: arguments.rerank_query,
                hypothetical_answer: arguments.hypothetical_answer,
                keywords: arguments.keywords,
                resolved_refs,
                warnings,
                mode: arguments.response_mode,
            }),
        })
    }

    fn component_name(&self) -> String {
        format!(
            "knowledge-search:{}+{}",
            self.retriever.component_name(),
            self.reranker.component_name()
        )
    }
}
