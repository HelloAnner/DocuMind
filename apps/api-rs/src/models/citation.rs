use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CitationAnchor {
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub page: Option<i32>,
    #[serde(default)]
    pub slide: Option<i32>,
    #[serde(default)]
    pub block_ids: Vec<Uuid>,
    #[serde(default)]
    pub table_ids: Vec<Uuid>,
    #[serde(default)]
    pub location_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Citation {
    pub id: Uuid,
    pub assistant_message_id: Uuid,
    pub index: i32,
    pub chunk_id: Uuid,
    pub doc_id: Uuid,
    pub doc_title: String,
    pub page_range: Vec<i32>,
    pub heading_path: Vec<String>,
    pub quote: String,
    pub score: f64,
    pub source_status: String,
    pub anchor: Option<CitationAnchor>,
}
