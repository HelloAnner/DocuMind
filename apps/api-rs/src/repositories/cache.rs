use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::models::agent::CitationOutput;
use crate::models::Confidence;

#[derive(Debug, Clone)]
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
        Ok(inner.get(key).filter(|v| v.expires_at > Utc::now()).cloned())
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

pub fn cache_key(
    version: &str,
    tenant_id: Uuid,
    kb_ids: &[Uuid],
    query: &str,
    doc_version_hash: &str,
) -> String {
    let mut kb_sorted: Vec<String> = kb_ids.iter().map(|id| id.to_string()).collect();
    kb_sorted.sort();
    let kb_scope_hash = format!("{:x}", md5_hash(&kb_sorted.join(",")));
    let query_fingerprint = format!("{:x}", md5_hash(query));
    format!(
        "conversation:answer:{version}:{tenant_id}:{kb_scope_hash}:{query_fingerprint}:{doc_version_hash}"
    )
}

fn md5_hash(input: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    hasher.finish()
}
