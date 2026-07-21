use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::models::rag::{RerankInput, RerankedChunk};

#[async_trait::async_trait]
pub trait Reranker: Send + Sync {
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>>;
    fn component_name(&self) -> String;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RerankProvider {
    DashScope,
    OpenAiCompatible,
}

impl RerankProvider {
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "dashscope" => Ok(Self::DashScope),
            "openai" | "openai_compatible" | "cohere_compatible" => Ok(Self::OpenAiCompatible),
            other => bail!("unsupported rerank provider: {other}"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::DashScope => "dashscope",
            Self::OpenAiCompatible => "openai_compatible",
        }
    }
}

pub struct HttpReranker {
    http: reqwest::Client,
    api_url: String,
    api_key: Option<String>,
    model: String,
    provider: RerankProvider,
}

#[derive(Debug, Serialize)]
struct CompatibleRequest<'a> {
    model: &'a str,
    query: &'a str,
    documents: &'a [String],
    top_n: usize,
}

#[derive(Debug, Serialize)]
struct DashScopeRequest<'a> {
    model: &'a str,
    input: DashScopeInput<'a>,
    parameters: DashScopeParameters,
}

#[derive(Debug, Serialize)]
struct DashScopeInput<'a> {
    query: &'a str,
    documents: &'a [String],
}

#[derive(Debug, Serialize)]
struct DashScopeParameters {
    return_documents: bool,
    top_n: usize,
}

#[derive(Debug, Deserialize)]
struct RerankResult {
    index: usize,
    #[serde(default, alias = "relevance_score")]
    score: f64,
}

impl HttpReranker {
    pub fn new(
        api_url: String,
        api_key: Option<String>,
        model: String,
        provider: RerankProvider,
    ) -> Result<Self> {
        if api_url.trim().is_empty() {
            bail!("rerank api url is empty");
        }
        if model.trim().is_empty() {
            bail!("rerank model is empty");
        }
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()?;
        Ok(Self {
            http,
            api_url,
            api_key,
            model,
            provider,
        })
    }

    async fn request(
        &self,
        query: &str,
        documents: &[String],
        top_n: usize,
    ) -> Result<Vec<RerankResult>> {
        let mut request = self
            .http
            .post(&self.api_url)
            .header("Content-Type", "application/json");
        if let Some(api_key) = &self.api_key {
            request = request.bearer_auth(api_key);
        }
        request = match self.provider {
            RerankProvider::DashScope => request.json(&DashScopeRequest {
                model: &self.model,
                input: DashScopeInput { query, documents },
                parameters: DashScopeParameters {
                    return_documents: false,
                    top_n,
                },
            }),
            RerankProvider::OpenAiCompatible => request.json(&CompatibleRequest {
                model: &self.model,
                query,
                documents,
                top_n,
            }),
        };
        let response = request.send().await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            let diagnostic = body.chars().take(1_000).collect::<String>();
            bail!("reranker request failed with HTTP {status}: {diagnostic}");
        }
        let payload: serde_json::Value = serde_json::from_str(&body)
            .map_err(|error| anyhow!("reranker returned invalid JSON: {error}"))?;
        parse_results(&payload)
    }

    pub async fn probe(&self) -> Result<()> {
        let results = self
            .request(
                "enterprise document retrieval readiness",
                &[
                    "enterprise document retrieval readiness".to_string(),
                    "unrelated weather observation".to_string(),
                ],
                1,
            )
            .await?;
        let first = results
            .first()
            .ok_or_else(|| anyhow!("reranker readiness probe returned no result"))?;
        if first.index >= 2 || !first.score.is_finite() {
            bail!("reranker readiness probe returned an invalid result");
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl Reranker for HttpReranker {
    async fn rerank(&self, input: RerankInput) -> Result<Vec<RerankedChunk>> {
        if input.chunks.is_empty() {
            return Ok(vec![]);
        }
        let documents = input
            .chunks
            .iter()
            .map(rerank_document_text)
            .collect::<Vec<_>>();
        let mut results = self
            .request(&input.query, &documents, input.top_k.max(1))
            .await?;
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut reranked = Vec::new();
        for result in results.into_iter().take(input.top_k.max(1)) {
            let chunk = input.chunks.get(result.index).cloned().ok_or_else(|| {
                anyhow!("reranker returned invalid document index {}", result.index)
            })?;
            reranked.push(RerankedChunk {
                chunk,
                score: result.score,
                rank: reranked.len() as i32 + 1,
            });
        }
        Ok(reranked)
    }

    fn component_name(&self) -> String {
        format!("{}:{}", self.provider.as_str(), self.model)
    }
}

fn parse_results(payload: &serde_json::Value) -> Result<Vec<RerankResult>> {
    let results = payload
        .get("results")
        .or_else(|| {
            payload
                .get("output")
                .and_then(|output| output.get("results"))
        })
        .ok_or_else(|| anyhow!("reranker response is missing results"))?;
    let parsed = serde_json::from_value::<Vec<RerankResult>>(results.clone())?;
    if parsed.is_empty() {
        bail!("reranker returned no results");
    }
    Ok(parsed)
}

fn rerank_document_text(chunk: &crate::models::rag::RetrievedChunk) -> String {
    serde_json::json!({
        "document_title": chunk.doc_title,
        "heading_path": chunk.heading_path,
        "content": chunk.content,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dashscope_response() {
        let value = serde_json::json!({
            "output": {"results": [
                {"index": 1, "relevance_score": 0.91},
                {"index": 0, "relevance_score": 0.22}
            ]}
        });
        let results = parse_results(&value).expect("dashscope response should parse");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].index, 1);
        assert!((results[0].score - 0.91).abs() < f64::EPSILON);
    }

    #[test]
    fn rejects_unknown_provider() {
        assert!(RerankProvider::parse("rule_based").is_err());
    }
}
