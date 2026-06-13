use anyhow::Result;

use crate::models::rag::{RerankInput, RerankedChunk};

#[async_trait::async_trait]
pub trait Reranker: Send + Sync {
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>>;
}

pub struct MockReranker;

impl MockReranker {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl Reranker for MockReranker {
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>> {
        let query = input.query.to_lowercase();
        let mut ranked: Vec<RerankedChunk> = input
            .chunks
            .into_iter()
            .enumerate()
            .map(|(i, chunk)| {
                let score = rerank_score(&query, &chunk.content);
                RerankedChunk {
                    chunk,
                    score,
                    rank: i as i32 + 1,
                }
            })
            .collect();
        ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        for (i, item) in ranked.iter_mut().enumerate() {
            item.rank = i as i32 + 1;
        }
        Ok(ranked.into_iter().take(input.top_k).collect())
    }
}

fn rerank_score(query: &str, text: &str) -> f64 {
    let query_lower = query.to_lowercase();
    let text_lower = text.to_lowercase();
    if query_lower.is_empty() || text_lower.is_empty() {
        return 0.0;
    }
    if text_lower.contains(&query_lower) {
        return 0.95;
    }
    let q_chars: Vec<char> = query_lower.chars().filter(|c| !c.is_whitespace()).collect();
    let mut ngrams = std::collections::HashSet::new();
    for window in q_chars.windows(2) {
        ngrams.insert(window.iter().collect::<String>());
    }
    for window in q_chars.windows(3) {
        ngrams.insert(window.iter().collect::<String>());
    }
    if ngrams.is_empty() {
        return 0.0;
    }
    let hits = ngrams.iter().filter(|n| text_lower.contains(*n)).count();
    let density = hits as f64 / ngrams.len() as f64;
    // Sigmoid-ish scale
    0.3 + 0.7 * density
}
