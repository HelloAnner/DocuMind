use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::models::rag::{RetrievalInput, RetrievedChunk};
use crate::models::source_anchor::{CharRange, NormalizedBBox, SourceAnchor};
use crate::models::trace::RetrievalSource;
use crate::rag::embedding::{
    cosine_similarity, local_hash_embedding, vector_from_json, EmbeddingClient,
    EmbeddingClientConfig, LOCAL_HASH_EMBEDDING_DIM, LOCAL_HASH_EMBEDDING_MODEL,
};

#[async_trait::async_trait]
pub trait Retriever: Send + Sync {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>>;
}

pub struct MockRetriever {
    corpus: Vec<RetrievedChunk>,
}

pub struct PgRetriever {
    pool: PgPool,
}

pub struct EsRetriever {
    http: reqwest::Client,
    base_url: String,
    index_name: String,
    embedding_client: Option<EmbeddingClient>,
}

#[derive(Debug, Clone)]
struct CandidateChunk {
    chunk: RetrievedChunk,
    updated_at: chrono::DateTime<chrono::Utc>,
    embedding: Vec<f64>,
}

impl PgRetriever {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl EsRetriever {
    pub fn new(
        base_url: String,
        index_name: String,
        embedding_config: Option<EmbeddingClientConfig>,
    ) -> Result<Self> {
        let embedding_client = embedding_config.map(EmbeddingClient::new).transpose()?;
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            base_url: base_url.trim_end_matches('/').to_string(),
            index_name,
            embedding_client,
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
        let Some(client) = &self.embedding_client else {
            return Ok(vec![]);
        };
        let vector = client.embed_one(query).await?;
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
                    { "terms": { "kb_id": uuid_strings(&input.effective_kb_ids) } }
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
                        { "terms": { "kb_id": uuid_strings(&input.effective_kb_ids) } }
                    ],
                    "must": [
                        {
                            "multi_match": {
                                "query": query,
                                "fields": ["doc_title^6", "content^3", "heading_path^1.5"],
                                "type": "best_fields"
                            }
                        }
                    ]
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
        let resp = self
            .http
            .post(self.search_url())
            .json(&payload)
            .send()
            .await?
            .error_for_status()?;
        let body: serde_json::Value = resp.json().await?;
        let hits = body
            .get("hits")
            .and_then(|v| v.get("hits"))
            .and_then(serde_json::Value::as_array)
            .context("elasticsearch response missing hits.hits")?;

        let mut chunks = Vec::with_capacity(hits.len());
        for hit in hits {
            let score = hit
                .get("_score")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let Some(source_doc) = hit.get("_source") else {
                continue;
            };
            if let Some(chunk) = chunk_from_es_source(source_doc, score, source) {
                chunks.push(chunk);
            }
        }
        Ok(chunks)
    }
}

#[async_trait::async_trait]
impl Retriever for EsRetriever {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>> {
        if input.effective_kb_ids.is_empty() || input.queries.is_empty() {
            return Ok(vec![]);
        }

        let mut dense_hits = Vec::new();
        let mut bm25_hits = Vec::new();
        for query in &input.queries {
            dense_hits.extend(self.dense_search(query, &input).await?);
            bm25_hits.extend(self.bm25_search(query, &input).await?);
        }

        Ok(fuse_retrieved_hits(dense_hits, bm25_hits, input.top_k))
    }
}

impl Default for MockRetriever {
    fn default() -> Self {
        Self::new()
    }
}

impl MockRetriever {
    pub fn new() -> Self {
        Self {
            corpus: vec![
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap(),
                    doc_id: Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
                    doc_title: "2025年Q3采购合同.pdf".to_string(),
                    file_type: "pdf".to_string(),
                    content: "任何一方未按约定履行合同义务的，应当向对方支付合同金额10%的违约金。"
                        .to_string(),
                    heading_path: vec!["违约责任".to_string()],
                    page_range: vec![7],
                    block_ids: vec![
                        Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1").unwrap()
                    ],
                    table_ids: vec![],
                    anchor_ids: vec![],
                    primary_anchor_id: None,
                    anchor_quality: "structural".to_string(),
                    primary_anchor: None,
                    metadata: serde_json::json!({"source_type": "paragraph"}),
                    score: 0.88,
                    source: RetrievalSource::Dense,
                },
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("33333333-3333-3333-3333-333333333333").unwrap(),
                    doc_id: Uuid::parse_str("22222222-2222-2222-2222-222222222222").unwrap(),
                    doc_title: "2025年Q3采购合同.pdf".to_string(),
                    file_type: "pdf".to_string(),
                    content:
                        "付款节点：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。"
                            .to_string(),
                    heading_path: vec!["付款条款".to_string()],
                    page_range: vec![5],
                    block_ids: vec![
                        Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2").unwrap()
                    ],
                    table_ids: vec![],
                    anchor_ids: vec![],
                    primary_anchor_id: None,
                    anchor_quality: "structural".to_string(),
                    primary_anchor: None,
                    metadata: serde_json::json!({"source_type": "paragraph"}),
                    score: 0.92,
                    source: RetrievalSource::Dense,
                },
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("44444444-4444-4444-4444-444444444444").unwrap(),
                    doc_id: Uuid::parse_str("55555555-5555-5555-5555-555555555555").unwrap(),
                    doc_title: "员工报销制度.pdf".to_string(),
                    file_type: "pdf".to_string(),
                    content:
                        "员工报销需提交发票原件、费用明细、审批单，并在费用发生后30个工作日内提交。"
                            .to_string(),
                    heading_path: vec!["报销流程".to_string()],
                    page_range: vec![2],
                    block_ids: vec![
                        Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3").unwrap()
                    ],
                    table_ids: vec![],
                    anchor_ids: vec![],
                    primary_anchor_id: None,
                    anchor_quality: "structural".to_string(),
                    primary_anchor: None,
                    metadata: serde_json::json!({"source_type": "paragraph"}),
                    score: 0.85,
                    source: RetrievalSource::Bm25,
                },
                RetrievedChunk {
                    chunk_id: Uuid::parse_str("66666666-6666-6666-6666-666666666666").unwrap(),
                    doc_id: Uuid::parse_str("77777777-7777-7777-7777-777777777777").unwrap(),
                    doc_title: "2025年度销售策略.pptx".to_string(),
                    file_type: "pptx".to_string(),
                    content:
                        "Q3华东区域销售目标为1200万元，较去年同期增长15%，其中新客户占比不低于30%。"
                            .to_string(),
                    heading_path: vec!["Q3目标".to_string(), "分地区策略".to_string()],
                    page_range: vec![3, 4],
                    block_ids: vec![
                        Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4").unwrap()
                    ],
                    table_ids: vec![],
                    anchor_ids: vec![],
                    primary_anchor_id: None,
                    anchor_quality: "structural".to_string(),
                    primary_anchor: None,
                    metadata: serde_json::json!({"source_type": "paragraph", "slide_start": 3}),
                    score: 0.90,
                    source: RetrievalSource::Rrf,
                },
            ],
        }
    }
}

#[async_trait::async_trait]
impl Retriever for PgRetriever {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>> {
        if input.effective_kb_ids.is_empty() || input.queries.is_empty() {
            return Ok(vec![]);
        }

        let candidate_limit = (input.dense_top_k.max(input.bm25_top_k).max(input.top_k) * 50)
            .clamp(1000, 5000) as i64;
        let rows = sqlx::query(
            "SELECT c.id AS chunk_id,
                    c.doc_id,
                    d.title AS doc_title,
                    d.file_type,
                    c.content,
                    c.heading_path,
                    c.page_range,
                    c.block_ids,
                    c.table_ids,
                    c.anchor_ids,
                    c.primary_anchor_id,
                    c.anchor_quality,
                    a.id AS anchor_id,
                    a.parse_job_id AS anchor_parse_job_id,
                    a.format AS anchor_format,
                    a.kind AS anchor_kind,
                    a.page AS anchor_page,
                    a.slide AS anchor_slide,
                    a.block_id AS anchor_block_id,
                    a.table_id AS anchor_table_id,
                    a.cell_range AS anchor_cell_range,
                    a.char_range AS anchor_char_range,
                    a.bbox AS anchor_bbox,
                    a.source_ref AS anchor_source_ref,
                    a.text AS anchor_text,
                    a.text_hash AS anchor_text_hash,
                    a.anchor_quality AS anchor_anchor_quality,
                    c.metadata,
                    d.updated_at,
                    e.embedding_vector
             FROM chunks c
             JOIN documents d ON d.id = c.doc_id
             LEFT JOIN chunk_embeddings e
                    ON e.chunk_id = c.id
                   AND e.embedding_model = $4
                   AND e.status = 'completed'
             LEFT JOIN chunk_anchor_map cam
                    ON cam.chunk_id = c.id AND cam.relation = 'primary'
             LEFT JOIN document_source_anchors a
                    ON a.id = cam.anchor_id
             WHERE c.tenant_id = $1
               AND c.kb_id = ANY($2)
               AND d.parse_status = 'indexed'
               AND d.latest_parse_job_id = c.parse_job_id
             ORDER BY d.updated_at DESC, c.chunk_index ASC
             LIMIT $3",
        )
        .bind(input.tenant_id)
        .bind(&input.effective_kb_ids)
        .bind(candidate_limit)
        .bind(LOCAL_HASH_EMBEDDING_MODEL)
        .fetch_all(&self.pool)
        .await?;

        let mut candidates = vec![];
        for row in rows {
            let content: String = row.try_get("content")?;
            let embedding_value: Option<serde_json::Value> =
                row.try_get("embedding_vector").unwrap_or(None);
            let embedding = embedding_value
                .as_ref()
                .and_then(vector_from_json)
                .filter(|v| v.len() == LOCAL_HASH_EMBEDDING_DIM)
                .unwrap_or_else(|| local_hash_embedding(&content));
            let updated_at: chrono::DateTime<chrono::Utc> = row.try_get("updated_at")?;
            let primary_anchor: Option<crate::models::SourceAnchor> = row
                .try_get::<Option<Uuid>, _>("anchor_id")
                .unwrap_or(None)
                .map(|anchor_id| crate::models::SourceAnchor {
                    anchor_id,
                    doc_id: row.try_get("doc_id").unwrap_or_default(),
                    parse_job_id: row.try_get("anchor_parse_job_id").unwrap_or_default(),
                    tenant_id: input.tenant_id,
                    format: row.try_get("anchor_format").unwrap_or_default(),
                    kind: row.try_get("anchor_kind").unwrap_or_default(),
                    page: row.try_get("anchor_page").unwrap_or(None),
                    slide: row.try_get("anchor_slide").unwrap_or(None),
                    block_id: row.try_get("anchor_block_id").unwrap_or(None),
                    table_id: row.try_get("anchor_table_id").unwrap_or(None),
                    cell_range: row
                        .try_get::<Option<sqlx::types::Json<_>>, _>("anchor_cell_range")
                        .ok()
                        .flatten()
                        .map(|j| j.0),
                    char_range: row
                        .try_get::<Option<sqlx::types::Json<_>>, _>("anchor_char_range")
                        .ok()
                        .flatten()
                        .map(|j| j.0),
                    bbox: row
                        .try_get::<Option<sqlx::types::Json<_>>, _>("anchor_bbox")
                        .ok()
                        .flatten()
                        .map(|j| j.0),
                    source_ref: row
                        .try_get("anchor_source_ref")
                        .unwrap_or_else(|_| serde_json::json!({})),
                    text: row.try_get("anchor_text").unwrap_or_default(),
                    text_hash: row.try_get("anchor_text_hash").unwrap_or(None),
                    anchor_quality: row
                        .try_get("anchor_anchor_quality")
                        .unwrap_or_else(|_| "unknown".to_string()),
                });

            candidates.push(CandidateChunk {
                updated_at,
                chunk: RetrievedChunk {
                    chunk_id: row.try_get("chunk_id")?,
                    doc_id: row.try_get("doc_id")?,
                    doc_title: row.try_get("doc_title")?,
                    file_type: row.try_get("file_type")?,
                    content,
                    heading_path: row.try_get("heading_path")?,
                    page_range: row.try_get("page_range")?,
                    block_ids: row.try_get("block_ids").unwrap_or_default(),
                    table_ids: row.try_get("table_ids").unwrap_or_default(),
                    anchor_ids: row.try_get("anchor_ids").unwrap_or_default(),
                    primary_anchor_id: row.try_get("primary_anchor_id").unwrap_or(None),
                    anchor_quality: row
                        .try_get("anchor_quality")
                        .unwrap_or_else(|_| "unknown".to_string()),
                    primary_anchor,
                    metadata: row
                        .try_get("metadata")
                        .unwrap_or_else(|_| serde_json::json!({})),
                    score: 0.0,
                    source: RetrievalSource::Rrf,
                },
                embedding,
            });
        }

        Ok(hybrid_rrf(
            &input.queries,
            candidates,
            input.top_k,
            input.dense_top_k,
            input.bm25_top_k,
        ))
    }
}

#[async_trait::async_trait]
impl Retriever for MockRetriever {
    async fn retrieve(&self, input: RetrievalInput) -> Result<Vec<RetrievedChunk>> {
        let mut seen = std::collections::HashSet::new();
        let mut all: Vec<(f64, RetrievedChunk)> = vec![];

        for query in &input.queries {
            let q = query.to_lowercase();
            for chunk in &self.corpus {
                let score = overlap_score(&q, &chunk.content);
                if score > 0.0 && seen.insert(chunk.chunk_id) {
                    let mut c = chunk.clone();
                    c.score = score;
                    all.push((score, c));
                }
            }
        }

        all.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let result: Vec<RetrievedChunk> = all
            .into_iter()
            .take(input.top_k.max(1))
            .map(|(_, c)| c)
            .collect();
        let _ = input.effective_kb_ids;
        Ok(result)
    }
}

fn fuse_retrieved_hits(
    dense_hits: Vec<RetrievedChunk>,
    bm25_hits: Vec<RetrievedChunk>,
    top_k: usize,
) -> Vec<RetrievedChunk> {
    let dense_rank = hit_rank_map(&dense_hits);
    let bm25_rank = hit_rank_map(&bm25_hits);
    let dense_ids: HashSet<Uuid> = dense_rank.keys().copied().collect();
    let bm25_ids: HashSet<Uuid> = bm25_rank.keys().copied().collect();

    let mut by_id: HashMap<Uuid, RetrievedChunk> = HashMap::new();
    for chunk in dense_hits.into_iter().chain(bm25_hits) {
        by_id
            .entry(chunk.chunk_id)
            .and_modify(|existing| {
                if chunk.score > existing.score {
                    *existing = chunk.clone();
                }
            })
            .or_insert(chunk);
    }

    let mut fused = Vec::new();
    for (chunk_id, mut chunk) in by_id {
        let mut score = 0.0;
        if let Some(rank) = dense_rank.get(&chunk_id) {
            score += reciprocal_rank(*rank);
        }
        if let Some(rank) = bm25_rank.get(&chunk_id) {
            score += reciprocal_rank(*rank);
        }
        if score == 0.0 {
            continue;
        }
        chunk.score = score;
        chunk.source = match (dense_ids.contains(&chunk_id), bm25_ids.contains(&chunk_id)) {
            (true, true) => RetrievalSource::Rrf,
            (true, false) => RetrievalSource::Dense,
            (false, true) => RetrievalSource::Bm25,
            (false, false) => RetrievalSource::Rrf,
        };
        fused.push(chunk);
    }

    fused.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    dedupe_retrieved_chunks(fused, top_k.max(1))
}

fn dedupe_retrieved_chunks(chunks: Vec<RetrievedChunk>, top_k: usize) -> Vec<RetrievedChunk> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();

    for chunk in chunks {
        let key = duplicate_content_key(&chunk);
        if !seen.insert(key) {
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
    let compact_content: String = chunk
        .content
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .take(256)
        .collect();
    format!("{}::{}", chunk.doc_title.trim(), compact_content)
}

fn hit_rank_map(hits: &[RetrievedChunk]) -> HashMap<Uuid, usize> {
    let mut ranks = HashMap::new();
    for hit in hits {
        let next_rank = ranks.len() + 1;
        ranks.entry(hit.chunk_id).or_insert(next_rank);
    }
    ranks
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
                .and_then(|v| v.as_i64())
                .map(|p| vec![p as i32])
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
        kind: string_value(source.get("anchor_kind")).unwrap_or_else(|| {
            if !table_ids.is_empty() {
                "table_region".to_string()
            } else if source
                .get("anchor_slide")
                .and_then(serde_json::Value::as_i64)
                .is_some()
            {
                "slide_shape".to_string()
            } else {
                "paragraph".to_string()
            }
        }),
        page: source
            .get("anchor_page")
            .and_then(serde_json::Value::as_i64)
            .map(|v| v as i32),
        slide: source
            .get("anchor_slide")
            .and_then(serde_json::Value::as_i64)
            .map(|v| v as i32),
        block_id: block_ids.first().copied(),
        table_id: table_ids.first().copied(),
        cell_range: None,
        char_range: source
            .get("anchor_char_range")
            .cloned()
            .and_then(|v| serde_json::from_value::<CharRange>(v).ok()),
        bbox: source
            .get("anchor_bbox")
            .cloned()
            .and_then(|v| serde_json::from_value::<NormalizedBBox>(v).ok()),
        source_ref: serde_json::json!({"source": "elasticsearch"}),
        text: string_value(source.get("anchor_text")).unwrap_or_default(),
        text_hash: None,
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
    value.as_str().and_then(|s| Uuid::parse_str(s).ok())
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
    let gte = range.get("gte")?.as_i64()? as i32;
    let lte = range
        .get("lte")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(gte as i64) as i32;
    Some((gte..=lte).take(20).collect())
}

fn overlap_score(query: &str, text: &str) -> f64 {
    let query_lower = query.to_lowercase();
    let text_lower = text.to_lowercase();
    if query_lower.is_empty() || text_lower.is_empty() {
        return 0.0;
    }
    let mut score = 0.0;
    // Full substring match gives high score
    if text_lower.contains(&query_lower) {
        score += 0.9;
    }
    // For Chinese / mixed text, use 2-gram and 3-gram char windows.
    let q_chars: Vec<char> = query_lower.chars().filter(|c| !c.is_whitespace()).collect();
    let mut ngrams = std::collections::HashSet::new();
    for window in q_chars.windows(2) {
        ngrams.insert(window.iter().collect::<String>());
    }
    for window in q_chars.windows(3) {
        ngrams.insert(window.iter().collect::<String>());
    }
    let mut hits = 0;
    for ngram in &ngrams {
        if text_lower.contains(ngram) {
            hits += 1;
        }
    }
    if !ngrams.is_empty() {
        score += 0.4 * (hits as f64);
    }
    score.min(1.0)
}

fn hybrid_rrf(
    queries: &[String],
    candidates: Vec<CandidateChunk>,
    top_k: usize,
    dense_top_k: usize,
    bm25_top_k: usize,
) -> Vec<RetrievedChunk> {
    if candidates.is_empty() || queries.is_empty() {
        return vec![];
    }

    let query_embeddings: Vec<Vec<f64>> = queries
        .iter()
        .map(|query| local_hash_embedding(query))
        .collect();

    let mut dense_scores = vec![];
    let mut bm25_scores = vec![];

    for candidate in &candidates {
        let dense = query_embeddings
            .iter()
            .map(|query_embedding| cosine_similarity(query_embedding, &candidate.embedding))
            .fold(0.0, f64::max);
        let bm25 = queries
            .iter()
            .map(|query| overlap_score(&query.to_lowercase(), &candidate.chunk.content))
            .fold(0.0, f64::max);

        if dense > 0.0 {
            dense_scores.push((candidate.chunk.chunk_id, dense));
        }
        if bm25 > 0.0 {
            bm25_scores.push((candidate.chunk.chunk_id, bm25));
        }
    }

    dense_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    bm25_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    dense_scores.truncate(dense_top_k.max(top_k).max(1));
    bm25_scores.truncate(bm25_top_k.max(top_k).max(1));

    let dense_rank = rank_map(&dense_scores);
    let bm25_rank = rank_map(&bm25_scores);
    let dense_ids: HashSet<Uuid> = dense_rank.keys().copied().collect();
    let bm25_ids: HashSet<Uuid> = bm25_rank.keys().copied().collect();

    let by_id: HashMap<Uuid, CandidateChunk> = candidates
        .into_iter()
        .map(|candidate| (candidate.chunk.chunk_id, candidate))
        .collect();

    let mut fused = vec![];
    for (chunk_id, candidate) in by_id {
        let mut score = 0.0;
        if let Some(rank) = dense_rank.get(&chunk_id) {
            score += reciprocal_rank(*rank);
        }
        if let Some(rank) = bm25_rank.get(&chunk_id) {
            score += reciprocal_rank(*rank);
        }
        if score == 0.0 {
            continue;
        }

        let mut chunk = candidate.chunk;
        chunk.score = score;
        chunk.source = match (dense_ids.contains(&chunk_id), bm25_ids.contains(&chunk_id)) {
            (true, true) => RetrievalSource::Rrf,
            (true, false) => RetrievalSource::Dense,
            (false, true) => RetrievalSource::Bm25,
            (false, false) => RetrievalSource::Rrf,
        };
        fused.push((score, candidate.updated_at, chunk));
    }

    fused.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.1.cmp(&a.1))
    });

    dedupe_retrieved_chunks(
        fused.into_iter().map(|(_, _, chunk)| chunk).collect(),
        top_k.max(1),
    )
}

fn rank_map(scores: &[(Uuid, f64)]) -> HashMap<Uuid, usize> {
    scores
        .iter()
        .enumerate()
        .map(|(index, (chunk_id, _))| (*chunk_id, index + 1))
        .collect()
}

fn reciprocal_rank(rank: usize) -> f64 {
    1.0 / (60.0 + rank as f64)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    #[test]
    fn hybrid_rrf_prefers_related_chunks() {
        let query = "付款节点".to_string();
        let candidates = vec![
            candidate_with_title(
                "11111111-1111-1111-1111-111111111111",
                "采购合同.docx",
                "付款节点包括首付款和验收款。",
            ),
            candidate_with_title(
                "22222222-2222-2222-2222-222222222222",
                "差旅制度.docx",
                "员工差旅住宿标准按城市级别执行。",
            ),
        ];

        let result = hybrid_rrf(&[query], candidates, 2, 100, 100);

        assert_eq!(
            result.first().map(|chunk| chunk.chunk_id),
            Some(Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap())
        );
        assert!(matches!(
            result.first().map(|chunk| chunk.source),
            Some(RetrievalSource::Rrf)
        ));
    }

    #[test]
    fn hybrid_rrf_dedupes_repeated_documents_before_truncation() {
        let query = "采购合同付款节点 员工报销提交时限".to_string();
        let candidates = vec![
            candidate_with_title(
                "11111111-1111-1111-1111-111111111111",
                "员工报销制度-API测试",
                "员工报销提交时限：费用发生后30个工作日内提交。",
            ),
            candidate_with_title(
                "22222222-2222-2222-2222-222222222222",
                "员工报销制度-API测试",
                "员工报销提交时限：费用发生后30个工作日内提交。",
            ),
            candidate_with_title(
                "33333333-3333-3333-3333-333333333333",
                "2026-Q3采购合同-API测试",
                "付款节点：合同签署后支付首付款30%，验收通过后支付60%。",
            ),
        ];

        let result = hybrid_rrf(&[query], candidates, 3, 100, 100);
        let titles: Vec<_> = result
            .iter()
            .map(|chunk| chunk.doc_title.as_str())
            .collect();

        assert!(titles.contains(&"员工报销制度-API测试"));
        assert!(titles.contains(&"2026-Q3采购合同-API测试"));
        assert_eq!(titles.len(), 2);
    }

    fn candidate_with_title(chunk_id: &str, doc_title: &str, content: &str) -> CandidateChunk {
        CandidateChunk {
            chunk: RetrievedChunk {
                chunk_id: Uuid::parse_str(chunk_id).unwrap(),
                doc_id: Uuid::new_v4(),
                doc_title: doc_title.to_string(),
                file_type: "docx".to_string(),
                content: content.to_string(),
                heading_path: vec![],
                page_range: vec![],
                block_ids: vec![],
                table_ids: vec![],
                anchor_ids: vec![],
                primary_anchor_id: None,
                anchor_quality: "structural".to_string(),
                primary_anchor: None,
                metadata: serde_json::json!({"source_type": "paragraph"}),
                score: 0.0,
                source: RetrievalSource::Rrf,
            },
            updated_at: Utc::now(),
            embedding: local_hash_embedding(content),
        }
    }
}
