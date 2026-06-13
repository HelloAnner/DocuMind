use anyhow::Result;
use uuid::Uuid;

use crate::models::rag::{RetrievalInput, RetrievedChunk};
use crate::models::trace::RetrievalSource;

#[async_trait::async_trait]
pub trait Retriever: Send + Sync {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>>;
}

pub struct MockRetriever {
    corpus: Vec<RetrievedChunk>,
}

impl Default for MockRetriever {
    fn default() -> Self {
        Self::new()
    }
}

impl MockRetriever {
    pub fn new() -> Self {
        Self {
            corpus: vec![
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap(),
                    doc_id: Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
                    doc_title: "2025年Q3采购合同.pdf".to_string(),
                    content: "任何一方未按约定履行合同义务的，应当向对方支付合同金额10%的违约金。".to_string(),
                    heading_path: vec!["违约责任".to_string()],
                    page_range: vec![7],
                    score: 0.88,
                    source: RetrievalSource::Dense,
                },
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap(),
                    doc_id: Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
                    doc_title: "2025年Q3采购合同.pdf".to_string(),
                    content: "付款节点：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。".to_string(),
                    heading_path: vec!["付款条款".to_string()],
                    page_range: vec![5],
                    score: 0.92,
                    source: RetrievalSource::Dense,
                },
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("44444444-4444-4444-4444-444444444444").unwrap(),
                    doc_id: Uuid::parse_str("55555555-5555-5555-5555-555555555555").unwrap(),
                    doc_title: "员工报销制度.pdf".to_string(),
                    content: "员工报销需提交发票原件、费用明细、审批单，并在费用发生后30个工作日内提交。".to_string(),
                    heading_path: vec!["报销流程".to_string()],
                    page_range: vec![2],
                    score: 0.85,
                    source: RetrievalSource::Bm25,
                },
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("66666666-6666-6666-6666-666666666666").unwrap(),
                    doc_id: Uuid::parse_str("77777777-7777-7777-7777-777777777777").unwrap(),
                    doc_title: "2025年度销售策略.pptx".to_string(),
                    content: "Q3华东区域销售目标为1200万元，较去年同期增长15%，其中新客户占比不低于30%。".to_string(),
                    heading_path: vec!["Q3目标".to_string(), "分地区策略".to_string()],
                    page_range: vec![3, 4],
                    score: 0.90,
                    source: RetrievalSource::Rrf,
                },
            ],
        }
    }
}

#[async_trait::async_trait]
impl Retriever for MockRetriever {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>> {
        let query = input
            .queries
            .first()
            .cloned()
            .unwrap_or_default()
            .to_lowercase();
        let mut scored: Vec<(f64, &RetrievedChunk)> = self
            .corpus
            .iter()
            .map(|chunk| {
                let score = overlap_score(&query, &chunk.content);
                (score, chunk)
            })
            .filter(|(s, _)| *s > 0.0)
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let result: Vec<RetrievedChunk> = scored
            .into_iter()
            .take(input.top_k)
            .map(|(s, chunk)| {
                let mut c = chunk.clone();
                c.score = s;
                c
            })
            .collect();
        // If effective_kb_ids is empty, still return matches for demo.
        let _ = input.effective_kb_ids;
        Ok(result)
    }
}

fn overlap_score(query: &str, text: &str) -> f64 {
    let query_lower = query.to_lowercase();
    let text_lower = text.to_lowercase();
    if query_lower.is_empty() || text_lower.is_empty() {
        return 0.0;
    }
    let mut score = 0.0;
    // Full substring match gives high score
    if text_lower.contains(&query_lower) {
        score += 0.9;
    }
    // For Chinese / mixed text, use 2-gram and 3-gram char windows.
    let q_chars: Vec<char> = query_lower.chars().filter(|c| !c.is_whitespace()).collect();
    let mut ngrams = std::collections::HashSet::new();
    for window in q_chars.windows(2) {
        ngrams.insert(window.iter().collect::<String>());
    }
    for window in q_chars.windows(3) {
        ngrams.insert(window.iter().collect::<String>());
    }
    let mut hits = 0;
    for ngram in &ngrams {
        if text_lower.contains(ngram) {
            hits += 1;
        }
    }
    if !ngrams.is_empty() {
        score += 0.4 * (hits as f64);
    }
    score.min(1.0)
}
