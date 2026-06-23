use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ElasticsearchConfig {
    pub base_url: String,
    pub index_name: String,
    pub alias_name: String,
    pub timeout_seconds: u64,
}

#[derive(Debug, Clone)]
pub struct ElasticsearchChunkIndexer {
    config: ElasticsearchConfig,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexedChunk {
    pub chunk_id: Uuid,
    pub doc_id: Uuid,
    pub kb_id: Uuid,
    pub tenant_id: Uuid,
    pub parse_job_id: Uuid,
    pub chunk_index: i32,
    pub source_type: String,
    pub content: String,
    pub heading_path: Vec<String>,
    pub page_range: Option<EsRange>,
    pub slide_start: Option<i32>,
    pub slide_end: Option<i32>,
    pub token_count: i32,
    pub block_ids: Vec<Uuid>,
    pub table_ids: Vec<Uuid>,
    pub embedding_model: String,
    pub embedding: Vec<f64>,
    pub metadata: Value,
    pub created_at: DateTime<Utc>,
    pub embedded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EsRange {
    pub gte: i32,
    pub lte: i32,
}

impl ElasticsearchChunkIndexer {
    pub fn new(config: ElasticsearchConfig) -> Result<Self> {
        if config.base_url.trim().is_empty() {
            bail!("elasticsearch url is empty");
        }
        if config.index_name.trim().is_empty() {
            bail!("elasticsearch chunk index name is empty");
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds))
            .build()?;
        Ok(Self { config, http })
    }

    pub async fn ensure_index(&self, dims: usize) -> Result<()> {
        if dims == 0 {
            bail!("embedding dimension must be greater than zero");
        }

        let index_url = self.index_url();
        let head = self.http.head(&index_url).send().await?;
        if head.status().as_u16() == 404 {
            self.http
                .put(&index_url)
                .json(&index_definition(dims))
                .send()
                .await?
                .error_for_status()?;
        } else {
            head.error_for_status()?;
        }

        if !self.config.alias_name.trim().is_empty() {
            let alias_url = format!(
                "{}/{}/_alias/{}",
                self.base_url(),
                self.config.index_name,
                self.config.alias_name
            );
            self.http.put(alias_url).send().await?.error_for_status()?;
        }
        Ok(())
    }

    pub async fn bulk_index(&self, chunks: &[IndexedChunk]) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        let dims = chunks
            .first()
            .map(|chunk| chunk.embedding.len())
            .ok_or_else(|| anyhow!("bulk index called without chunks"))?;
        if chunks.iter().any(|chunk| chunk.embedding.len() != dims) {
            bail!("all indexed chunk embeddings must have the same dimension");
        }
        self.ensure_index(dims).await?;

        let mut body = String::new();
        for chunk in chunks {
            body.push_str(&serde_json::to_string(&json!({
                "index": {
                    "_index": self.config.index_name,
                    "_id": chunk.chunk_id,
                }
            }))?);
            body.push('\n');
            body.push_str(&serde_json::to_string(chunk)?);
            body.push('\n');
        }

        let resp = self
            .http
            .post(format!("{}/_bulk", self.base_url()))
            .header("Content-Type", "application/x-ndjson")
            .body(body)
            .send()
            .await?
            .error_for_status()?;
        let payload: Value = resp.json().await?;
        if payload
            .get("errors")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let reason = payload
                .get("items")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        item.get("index")
                            .and_then(|index| index.get("error"))
                            .and_then(|error| error.get("reason").or(Some(error)))
                            .map(Value::to_string)
                    })
                })
                .unwrap_or_else(|| "bulk index reported errors".to_string());
            bail!("elasticsearch bulk index failed: {reason}");
        }
        Ok(())
    }

    fn base_url(&self) -> String {
        self.config.base_url.trim_end_matches('/').to_string()
    }

    fn index_url(&self) -> String {
        format!("{}/{}", self.base_url(), self.config.index_name)
    }
}

fn index_definition(dims: usize) -> Value {
    json!({
        "settings": {
            "number_of_shards": 1,
            "number_of_replicas": 0
        },
        "mappings": {
            "properties": {
                "chunk_id": { "type": "keyword" },
                "doc_id": { "type": "keyword" },
                "kb_id": { "type": "keyword" },
                "tenant_id": { "type": "keyword" },
                "parse_job_id": { "type": "keyword" },
                "chunk_index": { "type": "integer" },
                "source_type": { "type": "keyword" },
                "content": {
                    "type": "text",
                    "fields": {
                        "keyword": { "type": "keyword", "ignore_above": 32766 }
                    }
                },
                "heading_path": { "type": "keyword" },
                "page_range": { "type": "integer_range" },
                "slide_start": { "type": "integer" },
                "slide_end": { "type": "integer" },
                "token_count": { "type": "integer" },
                "block_ids": { "type": "keyword" },
                "table_ids": { "type": "keyword" },
                "embedding_model": { "type": "keyword" },
                "embedding": {
                    "type": "dense_vector",
                    "dims": dims,
                    "index": true,
                    "similarity": "cosine",
                    "index_options": {
                        "type": "hnsw",
                        "m": 16,
                        "ef_construction": 200
                    }
                },
                "created_at": { "type": "date" },
                "embedded_at": { "type": "date" }
            }
        }
    })
}
