use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::models::rag::{RerankInput, RerankedChunk};

#[async_trait::async_trait]
pub trait Reranker: Send + Sync {
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>>;
}

pub struct MockReranker;

pub struct HttpReranker {
    http: reqwest::Client,
    api_url: String,
    api_key: Option<String>,
    model: String,
}

#[derive(Debug, Serialize)]
struct RerankRequest<'a> {
    model: &'a str,
    query: &'a str,
    documents: Vec<&'a str>,
    top_n: usize,
}

#[derive(Debug, Deserialize)]
struct RerankResult {
    index: usize,
    #[serde(default, alias = "relevance_score")]
    score: f64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RerankResponse {
    Wrapped { results: Vec<RerankResult> },
    Bare(Vec<RerankResult>),
}

impl MockReranker {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MockReranker {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpReranker {
    pub fn new(api_url: String, api_key: Option<String>, model: String) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()?;
        Ok(Self {
            http,
            api_url,
            api_key,
            model,
        })
    }
}

#[async_trait::async_trait]
impl Reranker for HttpReranker {
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>> {
        if input.chunks.is_empty() {
            return Ok(vec![]);
        }

        let documents: Vec<String> = input.chunks.iter().map(rerank_document_text).collect();
        let document_refs: Vec<&str> = documents.iter().map(String::as_str).collect();
        let req = RerankRequest {
            model: &self.model,
            query: &input.query,
            documents: document_refs,
            top_n: input.top_k.max(1),
        };
        let mut request = self
            .http
            .post(&self.api_url)
            .header("Content-Type", "application/json")
            .json(&req);
        if let Some(api_key) = &self.api_key {
            request = request.header("Authorization", format!("Bearer {api_key}"));
        }

        let response = request.send().await?.error_for_status()?;
        let response: RerankResponse = response.json().await?;
        let mut results = match response {
            RerankResponse::Wrapped { results } => results,
            RerankResponse::Bare(results) => results,
        };
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut reranked = vec![];
        for result in results.into_iter().take(input.top_k.max(1)) {
            let Some(chunk) = input.chunks.get(result.index).cloned() else {
                return Err(anyhow!(
                    "reranker returned invalid document index {}",
                    result.index
                ));
            };
            reranked.push(RerankedChunk {
                chunk,
                score: result.score,
                rank: reranked.len() as i32 + 1,
            });
        }
        Ok(reranked)
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
                let document_text = rerank_document_text(&chunk);
                let score = rerank_score(&query, &document_text);
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

fn rerank_document_text(chunk: &crate::models::rag::RetrievedChunk) -> String {
    let heading = if chunk.heading_path.is_empty() {
        String::new()
    } else {
        format!("标题路径：{}\n", chunk.heading_path.join(" / "))
    };
    format!(
        "文档标题：{}\n{}{}",
        chunk.doc_title, heading, chunk.content
    )
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
    if hits == 0 {
        return 0.0;
    }
    let density = hits as f64 / ngrams.len() as f64;
    // Keep unrelated chunks below the default 0.3 threshold, while allowing
    // partial matches through when there is actual lexical evidence.
    0.25 + 0.75 * density
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::rag::{RerankInput, RetrievedChunk};
    use crate::models::trace::RetrievalSource;
    use uuid::Uuid;

    fn chunk(doc_title: &str, content: &str) -> RetrievedChunk {
        RetrievedChunk {
            chunk_id: Uuid::new_v4(),
            doc_id: Uuid::new_v4(),
            doc_title: doc_title.to_string(),
            file_type: "docx".to_string(),
            content: content.to_string(),
            heading_path: vec![],
            page_range: vec![1],
            block_ids: vec![],
            table_ids: vec![],
            anchor_ids: vec![],
            primary_anchor_id: None,
            anchor_quality: "structural".to_string(),
            primary_anchor: None,
            metadata: serde_json::json!({"source_type": "paragraph"}),
            score: 0.5,
            source: RetrievalSource::Rrf,
        }
    }

    #[tokio::test]
    async fn mock_reranker_uses_document_title_as_signal() {
        let reranked = MockReranker::new()
            .rerank(RerankInput {
                query: "DocuMind API测试采购合同讲了什么".to_string(),
                chunks: vec![
                    chunk(
                        "员工报销制度-API测试",
                        "DocuMind API测试制度。费用发生后30个工作日内提交。",
                    ),
                    chunk(
                        "2026-Q3采购合同-API测试",
                        "DocuMind API测试合同。付款节点包括首付款、验收款和质保金。",
                    ),
                ],
                top_k: 2,
            })
            .await
            .expect("rerank should succeed");

        assert_eq!(reranked[0].chunk.doc_title, "2026-Q3采购合同-API测试");
    }
}
