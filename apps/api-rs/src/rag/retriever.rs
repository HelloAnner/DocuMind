use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use futures::future::join_all;
use uuid::Uuid;

use crate::models::rag::{RetrievalInput, RetrievalOutput, RetrievedChunk};
use crate::models::source_anchor::{CharRange, NormalizedBBox, SourceAnchor};
use crate::models::trace::RetrievalSource;
use crate::rag::embedding::{EmbeddingClient, EmbeddingClientConfig};

#[async_trait::async_trait]
pub trait Retriever: Send + Sync {
    async fn retrieve(&self, input: RetrievalInput) -> Result<RetrievalOutput>;
    fn component_name(&self) -> String;
}

pub struct EsRetriever {
    http: reqwest::Client,
    base_url: String,
    index_name: String,
    embedding_model: String,
    embedding_client: EmbeddingClient,
}

impl EsRetriever {
    pub fn new(
        base_url: String,
        index_name: String,
        embedding_config: EmbeddingClientConfig,
        embedding_model: String,
    ) -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            base_url: base_url.trim_end_matches('/').to_string(),
            index_name,
            embedding_model,
            embedding_client: EmbeddingClient::new(embedding_config)?,
        })
    }

    fn search_url(&self) -> String {
        format!("{}/{}/_search", self.base_url, self.index_name)
    }

    async fn dense_search(
        &self,
        query: &str,
        input: &RetrievalInput,
    ) -> Result<Vec<RetrievedChunk>> {
        let vector = self.embedding_client.embed_one(query).await?;
        let payload = serde_json::json!({
            "size": input.dense_top_k.max(1),
            "_source": true,
            "knn": {
                "field": "embedding",
                "query_vector": vector,
                "k": input.dense_top_k.max(1),
                "num_candidates": input.dense_top_k.max(input.top_k).max(50) * 4,
                "filter": [
                    { "term": { "tenant_id": input.tenant_id.to_string() } },
                    { "terms": { "kb_id": uuid_strings(&input.effective_kb_ids) } },
                    { "term": { "embedding_model": &self.embedding_model } }
                ]
            }
        });
        self.search(payload, RetrievalSource::Dense).await
    }

    async fn bm25_search(
        &self,
        query: &str,
        input: &RetrievalInput,
    ) -> Result<Vec<RetrievedChunk>> {
        let payload = serde_json::json!({
            "size": input.bm25_top_k.max(1),
            "_source": true,
            "query": {
                "bool": {
                    "filter": [
                        { "term": { "tenant_id": input.tenant_id.to_string() } },
                        { "terms": { "kb_id": uuid_strings(&input.effective_kb_ids) } },
                        { "term": { "embedding_model": &self.embedding_model } }
                    ],
                    "must": [{
                        "multi_match": {
                            "query": query,
                            "fields": ["doc_title^6", "content^3", "content.standard^1.2", "heading_text^1.5"],
                            "type": "best_fields"
                        }
                    }]
                }
            }
        });
        self.search(payload, RetrievalSource::Bm25).await
    }

    async fn search(
        &self,
        payload: serde_json::Value,
        source: RetrievalSource,
    ) -> Result<Vec<RetrievedChunk>> {
        let response = self
            .http
            .post(self.search_url())
            .json(&payload)
            .send()
            .await?
            .error_for_status()?;
        let body: serde_json::Value = response.json().await?;
        let hits = body
            .get("hits")
            .and_then(|value| value.get("hits"))
            .and_then(serde_json::Value::as_array)
            .context("elasticsearch response missing hits.hits")?;
        Ok(hits
            .iter()
            .filter_map(|hit| {
                let score = hit
                    .get("_score")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                chunk_from_es_source(hit.get("_source")?, score, source)
            })
            .collect())
    }
}

#[async_trait::async_trait]
impl Retriever for EsRetriever {
    async fn retrieve(&self, input: RetrievalInput) -> Result<RetrievalOutput> {
        if input.effective_kb_ids.is_empty() || input.queries.is_empty() {
            return Ok(RetrievalOutput {
                chunks: vec![],
                warnings: vec![],
            });
        }
        let mut dense_queries = input.queries.clone();
        if let Some(hypothetical) = input
            .hypothetical_answer
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            dense_queries.push(hypothetical.to_string());
        }
        let dense_results = join_all(
            dense_queries
                .iter()
                .map(|query| self.dense_search(query, &input)),
        )
        .await;
        let bm25_results = join_all(
            input
                .queries
                .iter()
                .map(|query| self.bm25_search(query, &input)),
        )
        .await;

        let (dense_lists, dense_failures) = successful_lists(dense_results, "dense");
        let (bm25_lists, bm25_failures) = successful_lists(bm25_results, "bm25");
        for failure in dense_failures.iter().chain(&bm25_failures) {
            tracing::warn!(failure, "retrieval query degraded");
        }
        if dense_lists.is_empty() {
            anyhow::bail!(
                "vector retrieval failed for every query: {}",
                dense_failures.join("; ")
            );
        }
        let warnings = dense_failures.into_iter().chain(bm25_failures).collect();
        Ok(RetrievalOutput {
            chunks: fuse_ranked_lists(dense_lists, bm25_lists, input.top_k),
            warnings,
        })
    }

    fn component_name(&self) -> String {
        format!("elasticsearch-hybrid:{}", self.index_name)
    }
}

fn successful_lists(
    results: Vec<Result<Vec<RetrievedChunk>>>,
    channel: &str,
) -> (Vec<Vec<RetrievedChunk>>, Vec<String>) {
    let mut lists = Vec::new();
    let mut failures = Vec::new();
    for result in results {
        match result {
            Ok(hits) => lists.push(hits),
            Err(error) => failures.push(format!("{channel} retrieval failed: {error}")),
        }
    }
    (lists, failures)
}

fn fuse_ranked_lists(
    dense_lists: Vec<Vec<RetrievedChunk>>,
    bm25_lists: Vec<Vec<RetrievedChunk>>,
    top_k: usize,
) -> Vec<RetrievedChunk> {
    #[derive(Clone)]
    struct FusionState {
        chunk: RetrievedChunk,
        score: f64,
        dense: bool,
        bm25: bool,
    }

    let mut states: HashMap<Uuid, FusionState> = HashMap::new();
    for (is_dense, lists) in [(true, dense_lists), (false, bm25_lists)] {
        for list in lists {
            let mut seen_in_list = HashSet::new();
            for (index, chunk) in list.into_iter().enumerate() {
                if !seen_in_list.insert(chunk.chunk_id) {
                    continue;
                }
                let state = states.entry(chunk.chunk_id).or_insert_with(|| FusionState {
                    chunk: chunk.clone(),
                    score: 0.0,
                    dense: false,
                    bm25: false,
                });
                if chunk.score > state.chunk.score {
                    state.chunk = chunk;
                }
                state.score += reciprocal_rank(index + 1);
                state.dense |= is_dense;
                state.bm25 |= !is_dense;
            }
        }
    }
    let mut fused = states
        .into_values()
        .map(|state| {
            let mut chunk = state.chunk;
            chunk.score = state.score;
            chunk.source = match (state.dense, state.bm25) {
                (true, true) => RetrievalSource::Rrf,
                (true, false) => RetrievalSource::Dense,
                (false, true) => RetrievalSource::Bm25,
                (false, false) => RetrievalSource::Rrf,
            };
            chunk
        })
        .collect::<Vec<_>>();
    fused.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    dedupe_retrieved_chunks(fused, top_k.max(1))
}

fn reciprocal_rank(rank: usize) -> f64 {
    1.0 / (60.0 + rank as f64)
}

fn dedupe_retrieved_chunks(chunks: Vec<RetrievedChunk>, top_k: usize) -> Vec<RetrievedChunk> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for chunk in chunks {
        if !seen.insert(duplicate_content_key(&chunk)) {
            continue;
        }
        unique.push(chunk);
        if unique.len() >= top_k {
            break;
        }
    }
    unique
}

fn duplicate_content_key(chunk: &RetrievedChunk) -> String {
    let compact_content = chunk
        .content
        .chars()
        .filter(|character| !character.is_whitespace())
        .take(256)
        .collect::<String>();
    format!("{}::{compact_content}", chunk.doc_title.trim())
}

fn chunk_from_es_source(
    source: &serde_json::Value,
    score: f64,
    retrieval_source: RetrievalSource,
) -> Option<RetrievedChunk> {
    let chunk_id = uuid_value(source.get("chunk_id")?)?;
    let doc_id = uuid_value(source.get("doc_id")?)?;
    let doc_title = string_value(source.get("doc_title"))
        .or_else(|| string_value(source.get("title")))
        .unwrap_or_else(|| "未命名文档".to_string());
    let file_type = string_value(source.get("file_type")).unwrap_or_else(|| "unknown".to_string());
    let content = string_value(source.get("content"))?;
    let heading_path = string_vec(source.get("heading_path"));
    let block_ids = uuid_vec(source.get("block_ids"));
    let table_ids = uuid_vec(source.get("table_ids"));
    let anchor_ids = uuid_vec(source.get("anchor_ids"));
    let primary_anchor_id = source.get("primary_anchor_id").and_then(uuid_value);
    let anchor_quality =
        string_value(source.get("anchor_quality")).unwrap_or_else(|| "unknown".to_string());
    let metadata = source
        .get("metadata")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let page_range = page_range_from_es(source.get("page_range"))
        .or_else(|| {
            source
                .get("anchor_page")
                .and_then(serde_json::Value::as_i64)
                .map(|page| vec![page as i32])
        })
        .unwrap_or_default();
    let primary_anchor = primary_anchor_id.map(|anchor_id| SourceAnchor {
        anchor_id,
        doc_id,
        parse_job_id: source
            .get("parse_job_id")
            .and_then(uuid_value)
            .unwrap_or_else(Uuid::nil),
        tenant_id: source
            .get("tenant_id")
            .and_then(uuid_value)
            .unwrap_or_else(Uuid::nil),
        format: string_value(source.get("anchor_format")).unwrap_or_else(|| file_type.clone()),
        kind: string_value(source.get("anchor_kind")).unwrap_or_else(|| "paragraph".to_string()),
        page: source
            .get("anchor_page")
            .and_then(serde_json::Value::as_i64)
            .map(|value| value as i32),
        slide: source
            .get("anchor_slide")
            .and_then(serde_json::Value::as_i64)
            .map(|value| value as i32),
        block_id: block_ids.first().copied(),
        table_id: table_ids.first().copied(),
        cell_range: source
            .get("anchor_cell_range")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        char_range: source
            .get("anchor_char_range")
            .cloned()
            .and_then(|value| serde_json::from_value::<CharRange>(value).ok()),
        bbox: source
            .get("anchor_bbox")
            .cloned()
            .and_then(|value| serde_json::from_value::<NormalizedBBox>(value).ok()),
        source_ref: source
            .get("anchor_source_ref")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({"source": "elasticsearch"})),
        text: string_value(source.get("anchor_text")).unwrap_or_default(),
        text_hash: string_value(source.get("anchor_text_hash")),
        anchor_quality: anchor_quality.clone(),
    });

    Some(RetrievedChunk {
        chunk_id,
        doc_id,
        doc_title,
        file_type,
        content,
        heading_path,
        page_range,
        block_ids,
        table_ids,
        anchor_ids,
        primary_anchor_id,
        anchor_quality,
        primary_anchor,
        metadata,
        score,
        source: retrieval_source,
    })
}

fn uuid_strings(ids: &[Uuid]) -> Vec<String> {
    ids.iter().map(Uuid::to_string).collect()
}

fn uuid_value(value: &serde_json::Value) -> Option<Uuid> {
    value.as_str().and_then(|text| Uuid::parse_str(text).ok())
}

fn string_value(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn string_vec(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn uuid_vec(value: Option<&serde_json::Value>) -> Vec<Uuid> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(uuid_value).collect())
        .unwrap_or_default()
}

fn page_range_from_es(value: Option<&serde_json::Value>) -> Option<Vec<i32>> {
    let range = value?;
    if let Some(array) = range.as_array() {
        let pages = array
            .iter()
            .filter_map(|page| page.as_i64().map(|page| page as i32))
            .collect::<Vec<_>>();
        return (!pages.is_empty()).then_some(pages);
    }
    let start = range.get("gte")?.as_i64()? as i32;
    let end = range
        .get("lte")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(start as i64) as i32;
    Some((start..=end).take(20).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_query_contributes_an_independent_rrf_ranking() {
        let first = chunk("00000000-0000-0000-0000-000000000001", "A", "alpha");
        let second = chunk("00000000-0000-0000-0000-000000000002", "B", "beta");
        let fused = fuse_ranked_lists(
            vec![vec![first.clone(), second.clone()], vec![second, first]],
            vec![],
            2,
        );
        assert_eq!(fused.len(), 2);
        assert!((fused[0].score - fused[1].score).abs() < f64::EPSILON);
    }

    #[test]
    fn cross_channel_evidence_is_marked_as_rrf() {
        let shared = chunk("00000000-0000-0000-0000-000000000001", "A", "alpha");
        let other = chunk("00000000-0000-0000-0000-000000000002", "B", "beta");
        let fused = fuse_ranked_lists(vec![vec![shared.clone(), other]], vec![vec![shared]], 2);
        assert_eq!(fused[0].source, RetrievalSource::Rrf);
    }

    #[test]
    fn exact_duplicate_content_is_removed_after_fusion() {
        let first = chunk("00000000-0000-0000-0000-000000000001", "A", "same text");
        let duplicate = chunk("00000000-0000-0000-0000-000000000002", "A", "same text");
        let fused = fuse_ranked_lists(vec![vec![first, duplicate]], vec![], 5);
        assert_eq!(fused.len(), 1);
    }

    fn chunk(id: &str, title: &str, content: &str) -> RetrievedChunk {
        RetrievedChunk {
            chunk_id: Uuid::parse_str(id).expect("valid chunk id"),
            doc_id: Uuid::new_v4(),
            doc_title: title.to_string(),
            file_type: "txt".to_string(),
            content: content.to_string(),
            heading_path: vec![],
            page_range: vec![],
            block_ids: vec![],
            table_ids: vec![],
            anchor_ids: vec![],
            primary_anchor_id: None,
            anchor_quality: "structural".to_string(),
            primary_anchor: None,
            metadata: serde_json::json!({}),
            score: 1.0,
            source: RetrievalSource::Dense,
        }
    }
}
