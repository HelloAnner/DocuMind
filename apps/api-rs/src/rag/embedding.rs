use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::config::EmbeddingConfig;

pub const LOCAL_HASH_EMBEDDING_MODEL: &str = "local-hash-embedding-v1";
pub const LOCAL_HASH_EMBEDDING_DIM: usize = 64;

#[derive(Debug, Clone)]
pub struct EmbeddingClientConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub batch_size: usize,
    pub timeout_seconds: u64,
}

impl TryFrom<&EmbeddingConfig> for EmbeddingClientConfig {
    type Error = anyhow::Error;

    fn try_from(config: &EmbeddingConfig) -> Result<Self> {
        let api_key = config.api_key.clone().ok_or_else(|| {
            anyhow!("embedding api key is missing: set EMBED_API_KEY, LLM_API, or LLM_API_KEY")
        })?;
        if config.model.trim().is_empty() {
            bail!("embedding model is empty");
        }
        if config.base_url.trim().is_empty() {
            bail!("embedding base url is empty");
        }
        Ok(Self {
            base_url: config.base_url.clone(),
            api_key,
            model: config.model.clone(),
            batch_size: config.batch_size.clamp(1, 100),
            timeout_seconds: 120,
        })
    }
}

#[derive(Debug, Clone)]
pub struct EmbeddingClient {
    config: EmbeddingClientConfig,
    http: reqwest::Client,
}

#[derive(Debug, Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingData {
    embedding: Vec<f64>,
    index: Option<usize>,
}

impl EmbeddingClient {
    pub fn new(config: EmbeddingClientConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds))
            .build()?;
        Ok(Self { config, http })
    }

    pub fn model(&self) -> &str {
        &self.config.model
    }

    pub fn batch_size(&self) -> usize {
        self.config.batch_size
    }

    pub async fn embed_one(&self, text: &str) -> Result<Vec<f64>> {
        let mut vectors = self.embed_batch(&[text.to_string()]).await?;
        vectors
            .pop()
            .ok_or_else(|| anyhow!("embedding provider returned no vector"))
    }

    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f64>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.iter().any(|text| text.trim().is_empty()) {
            bail!("embedding input contains empty text");
        }

        let resp = self
            .http
            .post(self.embeddings_url())
            .header("Authorization", format!("Bearer {}", self.config.api_key))
            .header("Content-Type", "application/json")
            .json(&EmbeddingRequest {
                model: &self.config.model,
                input: texts,
            })
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<failed to read response body>".to_string());
            bail!("embedding provider returned HTTP {status}: {body}");
        }

        let payload: EmbeddingResponse = resp.json().await?;
        if payload.data.len() != texts.len() {
            bail!(
                "embedding provider returned {} vectors for {} inputs",
                payload.data.len(),
                texts.len()
            );
        }

        let mut ordered = vec![Vec::new(); texts.len()];
        for (fallback_index, item) in payload.data.into_iter().enumerate() {
            let index = item.index.unwrap_or(fallback_index);
            if index >= ordered.len() {
                bail!("embedding provider returned out-of-range index {index}");
            }
            if item.embedding.is_empty() {
                bail!("embedding provider returned empty vector at index {index}");
            }
            ordered[index] = item.embedding;
        }
        if ordered.iter().any(|v| v.is_empty()) {
            bail!("embedding provider response missed one or more vectors");
        }
        Ok(ordered)
    }

    fn embeddings_url(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        if base.ends_with("/embeddings") {
            base.to_string()
        } else {
            format!("{base}/embeddings")
        }
    }
}

pub fn local_hash_embedding(text: &str) -> Vec<f64> {
    let mut vector = vec![0.0; LOCAL_HASH_EMBEDDING_DIM];
    let normalized = text.to_lowercase();
    let chars: Vec<char> = normalized.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.is_empty() {
        return vector;
    }

    for n in [1, 2, 3] {
        for window in chars.windows(n) {
            let gram = window.iter().collect::<String>();
            let index = stable_hash(&gram) as usize % LOCAL_HASH_EMBEDDING_DIM;
            vector[index] += 1.0 / n as f64;
        }
    }

    normalize(&mut vector);
    vector
}

pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let len = a.len().min(b.len());
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..len {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        (dot / norm_a.sqrt() / norm_b.sqrt()).clamp(0.0, 1.0)
    }
}

pub fn vector_from_json(value: &serde_json::Value) -> Option<Vec<f64>> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_f64()).collect())
}

fn normalize(vector: &mut [f64]) {
    let norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
    if norm > 0.0 {
        for value in vector {
            *value /= norm;
        }
    }
}

fn stable_hash(text: &str) -> u64 {
    // FNV-1a keeps this fallback deterministic across platforms and releases.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_is_normalized_and_deterministic() {
        let a = local_hash_embedding("付款节点");
        let b = local_hash_embedding("付款节点");

        assert_eq!(a, b);
        assert_eq!(a.len(), LOCAL_HASH_EMBEDDING_DIM);
        let norm = a.iter().map(|v| v * v).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 0.000001);
    }

    #[test]
    fn cosine_scores_related_text_higher() {
        let query = local_hash_embedding("付款节点");
        let related = local_hash_embedding("合同付款节点和验收付款比例");
        let unrelated = local_hash_embedding("员工差旅住宿标准");

        assert!(cosine_similarity(&query, &related) > cosine_similarity(&query, &unrelated));
    }
}
