use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::config::EmbeddingConfig;

#[derive(Debug, Clone)]
pub struct EmbeddingClientConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub batch_size: usize,
    pub timeout_seconds: u64,
    pub retry_max: usize,
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
            retry_max: config.retry_max.max(1) as usize,
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

        let mut payload = None;
        for attempt in 1..=self.config.retry_max {
            let response = self
                .http
                .post(self.embeddings_url())
                .header("Authorization", format!("Bearer {}", self.config.api_key))
                .header("Content-Type", "application/json")
                .json(&EmbeddingRequest {
                    model: &self.config.model,
                    input: texts,
                })
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    payload = Some(response.json::<EmbeddingResponse>().await?);
                    break;
                }
                Ok(response) => {
                    let status = response.status();
                    let retryable = status.as_u16() == 429 || status.is_server_error();
                    let body = response
                        .text()
                        .await
                        .map(|body| body.chars().take(1_000).collect::<String>())
                        .unwrap_or_else(|_| "<failed to read response body>".to_string());
                    if !retryable || attempt == self.config.retry_max {
                        bail!("embedding provider returned HTTP {status}: {body}");
                    }
                }
                Err(error) => {
                    if attempt == self.config.retry_max {
                        return Err(error.into());
                    }
                }
            }
            let delay =
                Duration::from_millis((250_u64 * 2_u64.pow(attempt.min(6) as u32)).min(8_000));
            tokio::time::sleep(delay).await;
        }

        let payload =
            payload.ok_or_else(|| anyhow!("embedding retry loop completed without a response"))?;
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
