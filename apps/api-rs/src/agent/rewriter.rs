use anyhow::Result;

use crate::models::agent::{ConversationTurn, RewriteOutput};
use crate::models::trace::ResolvedRef;

#[async_trait::async_trait]
pub trait QueryRewriter: Send + Sync {
    async fn rewrite(
        &self,
        original_query: &str,
        history: &[ConversationTurn],
        effective_kb_ids: &[uuid::Uuid],
    ) -> Result<RewriteOutput>;
}

pub struct RuleBasedQueryRewriter;

impl RuleBasedQueryRewriter {
    pub fn new() -> Self {
        Self
    }

    fn extract_doc_title(answer: &str) -> Option<String> {
        // Very light heuristic: find 《...》
        if let Some(start) = answer.find('《') {
            if let Some(end) = answer[start + 3..].find('》') {
                return Some(answer[start + 3..start + 3 + end].to_string());
            }
        }
        None
    }
}

#[async_trait::async_trait]
impl QueryRewriter for RuleBasedQueryRewriter {
    async fn rewrite(
        &self,
        original_query: &str,
        history: &[ConversationTurn],
        _effective_kb_ids: &[uuid::Uuid],
    ) -> Result<RewriteOutput> {
        let pronouns = ["它", "这个", "那份", "上述", "上面"];
        let has_pronoun = pronouns.iter().any(|p| original_query.contains(p));

        let mut resolved_refs = vec![];
        let mut rewritten = original_query.to_string();
        let mut needs_clarification = false;
        let mut clarification_question: Option<String> = None;

        if has_pronoun {
            if let Some(last) = history.last() {
                if let Some(title) = Self::extract_doc_title(&last.assistant_answer) {
                    for p in &pronouns {
                        if rewritten.contains(*p) {
                            rewritten = rewritten.replace(*p, &title);
                            resolved_refs.push(ResolvedRef {
                                text: p.to_string(),
                                resolved_to: title.clone(),
                                source_message_id: None,
                                evidence_message_id: None,
                            });
                        }
                    }
                } else {
                    needs_clarification = true;
                    clarification_question = Some("你说的“它”具体是指哪一份文档？".to_string());
                }
            } else {
                needs_clarification = true;
                clarification_question = Some("能否指明你指的是哪一份文档？".to_string());
            }
        }

        let keywords = rewritten
            .split(|c: char| c.is_whitespace() || c == '？' || c == '?' || c == '，' || c == ',')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        Ok(RewriteOutput {
            rewritten_query: rewritten,
            keywords,
            hypothetical_answer: None,
            resolved_refs,
            added_constraints: vec![],
            removed_constraints: vec![],
            needs_clarification,
            clarification_question,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::agent::ConversationTurn;

    #[tokio::test]
    async fn resolves_pronoun_from_history() {
        let rewriter = RuleBasedQueryRewriter::new();
        let history = vec![ConversationTurn {
            user_message: "《Q3采购合同》的付款节点是什么".to_string(),
            assistant_answer: "根据《Q3采购合同》...".to_string(),
            citations: vec![],
        }];
        let out = rewriter
            .rewrite("它的违约责任是什么", &history, &[])
            .await
            .unwrap();
        assert!(out.rewritten_query.contains("Q3采购合同"));
        assert!(!out.needs_clarification);
    }

    #[tokio::test]
    async fn asks_for_clarification_without_history() {
        let rewriter = RuleBasedQueryRewriter::new();
        let out = rewriter.rewrite("它的违约责任是什么", &[], &[]).await.unwrap();
        assert!(out.needs_clarification);
    }
}
