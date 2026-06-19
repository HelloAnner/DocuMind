use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::agent::CitationOutput;
use crate::models::Confidence;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CachedAnswer {
    pub answer: String,
    pub citations: Vec<CitationOutput>,
    pub confidence: Confidence,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[async_trait]
pub trait AnswerCache: Send + Sync {
    async fn get(&self, key: &str) -> anyhow::Result<Option<CachedAnswer>>;
    async fn set(&self, key: &str, value: CachedAnswer) -> anyhow::Result<()>;
    async fn delete(&self, key: &str) -> anyhow::Result<()>;
}

pub struct InMemoryAnswerCache {
    inner: Arc<RwLock<HashMap<String, CachedAnswer>>>,
}

impl Default for InMemoryAnswerCache {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryAnswerCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl AnswerCache for InMemoryAnswerCache {
    async fn get(&self, key: &str) -> anyhow::Result<Option<CachedAnswer>> {
        let inner = self.inner.read().unwrap();
        Ok(inner
            .get(key)
            .filter(|v| v.expires_at > Utc::now())
            .cloned())
    }

    async fn set(&self, key: &str, value: CachedAnswer) -> anyhow::Result<()> {
        let mut inner = self.inner.write().unwrap();
        inner.insert(key.to_string(), value);
        Ok(())
    }

    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        let mut inner = self.inner.write().unwrap();
        inner.remove(key);
        Ok(())
    }
}

pub struct RedisAnswerCache {
    client: redis::Client,
}

impl RedisAnswerCache {
    pub fn new(client: redis::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl AnswerCache for RedisAnswerCache {
    async fn get(&self, key: &str) -> anyhow::Result<Option<CachedAnswer>> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let value: Option<String> = conn.get(key).await?;
        match value {
            Some(v) => {
                let cached: CachedAnswer = serde_json::from_str(&v)?;
                if cached.expires_at > Utc::now() {
                    Ok(Some(cached))
                } else {
                    let _: () = conn.del(key).await?;
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    async fn set(&self, key: &str, value: CachedAnswer) -> anyhow::Result<()> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let ttl_seconds = (value.expires_at - Utc::now()).num_seconds().max(1) as u64;
        let payload = serde_json::to_string(&value)?;
        let _: () = conn.set_ex(key, payload, ttl_seconds).await?;
        Ok(())
    }

    async fn delete(&self, key: &str) -> anyhow::Result<()> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let _: () = conn.del(key).await?;
        Ok(())
    }
}

pub fn cache_key(
    version: &str,
    tenant_id: Uuid,
    kb_ids: &[Uuid],
    query: &str,
    doc_version_hash: &str,
) -> String {
    let mut kb_sorted: Vec<String> = kb_ids.iter().map(|id| id.to_string()).collect();
    kb_sorted.sort();
    let kb_scope_hash = hash_str(&kb_sorted.join(","));
    let query_fingerprint = hash_str(query);
    format!(
        "conversation:answer:{version}:{tenant_id}:{kb_scope_hash}:{query_fingerprint}:{doc_version_hash}"
    )
}

fn hash_str(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

#[allow(dead_code)]
fn dt_from_timestamp(secs: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(secs, 0).single().unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stable_and_scope_order_independent() {
        let tenant_id = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        let kb_a = Uuid::parse_str("00000000-0000-0000-0000-000000000010").unwrap();
        let kb_b = Uuid::parse_str("00000000-0000-0000-0000-000000000011").unwrap();

        let first = cache_key("v1", tenant_id, &[kb_a, kb_b], "付款节点是什么？", "doc-v1");
        let second = cache_key("v1", tenant_id, &[kb_b, kb_a], "付款节点是什么？", "doc-v1");
        let changed_doc = cache_key("v1", tenant_id, &[kb_a, kb_b], "付款节点是什么？", "doc-v2");

        assert_eq!(first, second);
        assert_ne!(first, changed_doc);
        assert!(first.contains("doc-v1"));
    }
}
