use std::collections::HashSet;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::models::source_anchor::{CharRange, NormalizedBBox};

mod schema;

use schema::index_definition;
pub use schema::physical_index_name;

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
    pub doc_title: String,
    pub file_type: String,
    pub kb_id: Uuid,
    pub tenant_id: Uuid,
    pub parse_job_id: Uuid,
    pub chunk_index: i32,
    pub source_type: String,
    pub content: String,
    pub heading_path: Vec<String>,
    pub heading_text: String,
    pub page_range: Option<EsRange>,
    pub slide_start: Option<i32>,
    pub slide_end: Option<i32>,
    pub token_count: i32,
    pub block_ids: Vec<Uuid>,
    pub table_ids: Vec<Uuid>,
    pub anchor_ids: Vec<Uuid>,
    pub primary_anchor_id: Option<Uuid>,
    pub anchor_quality: String,
    pub anchor_format: String,
    pub anchor_kind: String,
    pub anchor_page: Option<i32>,
    pub anchor_slide: Option<i32>,
    pub anchor_char_range: Option<CharRange>,
    pub anchor_bbox: Option<NormalizedBBox>,
    pub anchor_text: String,
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

    pub fn index_name(&self) -> &str {
        &self.config.index_name
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
            self.validate_index_dimension(dims).await?;
        }
        Ok(())
    }

    pub async fn reset_inactive_index(&self, dims: usize) -> Result<()> {
        if self
            .alias_targets()
            .await?
            .contains(&self.config.index_name)
        {
            bail!(
                "refusing to reset index {} while it is attached to alias {}",
                self.config.index_name,
                self.config.alias_name
            );
        }
        let response = self.http.delete(self.index_url()).send().await?;
        if response.status().as_u16() != 404 {
            response.error_for_status()?;
        }
        self.ensure_index(dims).await
    }

    pub async fn switch_alias(&self) -> Result<Vec<String>> {
        if self.config.alias_name.trim().is_empty() {
            bail!("elasticsearch search alias is empty");
        }
        let previous = self.alias_targets().await?;
        let mut actions = previous
            .iter()
            .filter(|index| *index != &self.config.index_name)
            .map(|index| json!({"remove": {"index": index, "alias": self.config.alias_name}}))
            .collect::<Vec<_>>();
        actions.push(json!({
            "add": {
                "index": self.config.index_name,
                "alias": self.config.alias_name,
                "is_write_index": true
            }
        }));
        self.http
            .post(format!("{}/_aliases", self.base_url()))
            .json(&json!({"actions": actions}))
            .send()
            .await?
            .error_for_status()?;
        Ok(previous)
    }

    pub async fn alias_targets(&self) -> Result<Vec<String>> {
        let response = self
            .http
            .get(format!(
                "{}/_alias/{}",
                self.base_url(),
                self.config.alias_name
            ))
            .send()
            .await?;
        if response.status().as_u16() == 404 {
            return Ok(Vec::new());
        }
        let payload: Value = response.error_for_status()?.json().await?;
        let indices = payload
            .as_object()
            .ok_or_else(|| anyhow!("elasticsearch alias response is not an object"))?;
        Ok(indices.keys().cloned().collect())
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
        let has_errors = payload
            .get("errors")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("elasticsearch bulk response is missing errors"))?;
        if has_errors {
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

    pub async fn delete_document_chunks(&self, doc_id: Uuid) -> Result<u64> {
        let resp = self
            .http
            .post(format!(
                "{}/_delete_by_query?conflicts=proceed&refresh=true",
                self.index_url()
            ))
            .json(&json!({
                "query": {
                    "term": {
                        "doc_id": doc_id
                    }
                }
            }))
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(0);
        }
        let payload: Value = resp.error_for_status()?.json().await?;
        payload
            .get("deleted")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("elasticsearch delete response is missing deleted"))
    }

    pub async fn update_document_kb(
        &self,
        tenant_id: Uuid,
        doc_id: Uuid,
        kb_id: Uuid,
    ) -> Result<u64> {
        let resp = self
            .http
            .post(format!(
                "{}/_update_by_query?conflicts=proceed&refresh=true",
                self.index_url()
            ))
            .json(&document_kb_update_body(tenant_id, doc_id, kb_id))
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(0);
        }
        let payload: Value = resp.error_for_status()?.json().await?;
        payload
            .get("updated")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("elasticsearch update response is missing updated"))
    }

    pub async fn refresh(&self) -> Result<()> {
        self.http
            .post(format!("{}/_refresh", self.index_url()))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn count(&self) -> Result<u64> {
        let response = self
            .http
            .get(format!("{}/_count", self.index_url()))
            .send()
            .await?;
        if response.status().as_u16() == 404 {
            return Ok(0);
        }
        let payload: Value = response.error_for_status()?.json().await?;
        payload
            .get("count")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("elasticsearch count response is missing count"))
    }

    pub async fn chunk_ids(&self) -> Result<HashSet<Uuid>> {
        let response = self
            .http
            .post(format!("{}/_search?scroll=1m", self.index_url()))
            .json(&json!({
                "size": 5_000,
                "_source": false,
                "sort": ["_doc"]
            }))
            .send()
            .await?;
        if response.status().as_u16() == 404 {
            return Ok(HashSet::new());
        }
        let mut payload: Value = response.error_for_status()?.json().await?;
        let mut ids = HashSet::new();
        let mut scroll_id = payload
            .get("_scroll_id")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        loop {
            let hits = payload
                .pointer("/hits/hits")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("elasticsearch scroll response is missing hits"))?;
            if hits.is_empty() {
                break;
            }
            for hit in hits {
                let id = hit
                    .get("_id")
                    .and_then(Value::as_str)
                    .and_then(|value| Uuid::parse_str(value).ok())
                    .ok_or_else(|| anyhow!("elasticsearch chunk document has an invalid _id"))?;
                ids.insert(id);
            }
            let Some(current_scroll_id) = scroll_id.as_deref() else {
                break;
            };
            payload = self
                .http
                .post(format!("{}/_search/scroll", self.base_url()))
                .json(&json!({"scroll": "1m", "scroll_id": current_scroll_id}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            scroll_id = payload
                .get("_scroll_id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
        }
        if let Some(scroll_id) = scroll_id {
            let _ = self
                .http
                .delete(format!("{}/_search/scroll", self.base_url()))
                .json(&json!({"scroll_id": [scroll_id]}))
                .send()
                .await;
        }
        Ok(ids)
    }

    pub async fn count_document_parse(&self, doc_id: Uuid, parse_job_id: Uuid) -> Result<u64> {
        let response = self
            .http
            .post(format!("{}/_count", self.index_url()))
            .json(&json!({
                "query": {"bool": {"filter": [
                    {"term": {"doc_id": doc_id}},
                    {"term": {"parse_job_id": parse_job_id}}
                ]}}
            }))
            .send()
            .await?;
        if response.status().as_u16() == 404 {
            return Ok(0);
        }
        let payload: Value = response.error_for_status()?.json().await?;
        payload
            .get("count")
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("elasticsearch document count response is missing count"))
    }

    pub async fn delete_index(&self, index: &str) -> Result<()> {
        if index == self.config.index_name {
            bail!("refusing to delete the active target index");
        }
        let response = self
            .http
            .delete(format!("{}/{}", self.base_url(), index))
            .send()
            .await?;
        if response.status().as_u16() == 404 {
            return Ok(());
        }
        response.error_for_status()?;
        Ok(())
    }

    async fn validate_index_dimension(&self, expected: usize) -> Result<()> {
        let response = self
            .http
            .get(format!("{}/_mapping/field/embedding", self.index_url()))
            .send()
            .await?
            .error_for_status()?;
        let payload: Value = response.json().await?;
        let actual = payload
            .get(&self.config.index_name)
            .and_then(|value| value.get("mappings"))
            .and_then(|value| value.get("embedding"))
            .and_then(|value| value.get("mapping"))
            .and_then(|value| value.get("embedding"))
            .and_then(|value| value.get("dims"))
            .and_then(Value::as_u64)
            .ok_or_else(|| anyhow!("elasticsearch embedding mapping is missing dims"))?;
        if actual as usize != expected {
            bail!(
                "elasticsearch index {} uses {} dimensions, expected {}",
                self.config.index_name,
                actual,
                expected
            );
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

fn document_kb_update_body(tenant_id: Uuid, doc_id: Uuid, kb_id: Uuid) -> Value {
    json!({
        "query": {
            "bool": {
                "filter": [
                    {"term": {"tenant_id": tenant_id}},
                    {"term": {"doc_id": doc_id}}
                ]
            }
        },
        "script": {
            "lang": "painless",
            "source": "ctx._source.kb_id = params.kb_id",
            "params": {"kb_id": kb_id}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::document_kb_update_body;
    use uuid::Uuid;

    #[test]
    fn document_kb_update_is_scoped_to_tenant_and_document() {
        let tenant_id = Uuid::new_v4();
        let doc_id = Uuid::new_v4();
        let kb_id = Uuid::new_v4();
        let body = document_kb_update_body(tenant_id, doc_id, kb_id);

        assert_eq!(
            body.pointer("/query/bool/filter/0/term/tenant_id"),
            Some(&serde_json::json!(tenant_id))
        );
        assert_eq!(
            body.pointer("/query/bool/filter/1/term/doc_id"),
            Some(&serde_json::json!(doc_id))
        );
        assert_eq!(
            body.pointer("/script/params/kb_id"),
            Some(&serde_json::json!(kb_id))
        );
    }
}
