use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use sqlx::Row;
use uuid::Uuid;

use crate::models::conversation_file::ConversationFile;
use crate::models::message::ConversationMessage;
use crate::models::MessageRole;

use super::memory::InMemoryConversationRepository;
use super::sqlx::SqlxConversationRepository;
use super::trait_repo::ConversationFileRepository;

#[async_trait]
impl ConversationFileRepository for SqlxConversationRepository {
    async fn list_conversation_files(
        &self,
        tenant_id: Uuid,
        conversation_id: Uuid,
        allowed_kb_ids: &[Uuid],
    ) -> anyhow::Result<Vec<ConversationFile>> {
        if allowed_kb_ids.is_empty() {
            return Ok(Vec::new());
        }

        let rows = sqlx::query(CONVERSATION_FILES_SQL)
            .bind(tenant_id)
            .bind(conversation_id)
            .bind(allowed_kb_ids)
            .fetch_all(&self.pool)
            .await?;

        rows.into_iter()
            .map(|row| {
                let anchor_value: Option<serde_json::Value> = row.try_get("preview_anchor")?;
                Ok(ConversationFile {
                    doc_id: row.try_get("doc_id")?,
                    doc_title: row.try_get("doc_title")?,
                    file_name: row.try_get("file_name")?,
                    file_type: row.try_get("file_type")?,
                    kb_id: row.try_get("kb_id")?,
                    kb_name: row.try_get("kb_name")?,
                    source_status: row.try_get("source_status")?,
                    retrieval_count: row.try_get("retrieval_count")?,
                    citation_count: row.try_get("citation_count")?,
                    last_used_at: row.try_get("last_used_at")?,
                    preview_page_range: row.try_get("preview_page_range")?,
                    preview_quote: row.try_get("preview_quote")?,
                    preview_anchor: anchor_value.map(serde_json::from_value).transpose()?,
                })
            })
            .collect()
    }
}

#[async_trait]
impl ConversationFileRepository for InMemoryConversationRepository {
    async fn list_conversation_files(
        &self,
        tenant_id: Uuid,
        conversation_id: Uuid,
        allowed_kb_ids: &[Uuid],
    ) -> anyhow::Result<Vec<ConversationFile>> {
        let _ = allowed_kb_ids;
        let messages: Vec<ConversationMessage> = self
            .messages
            .read()
            .unwrap()
            .values()
            .filter(|message| {
                message.tenant_id == tenant_id && message.conversation_id == conversation_id
            })
            .cloned()
            .collect();
        let retrieval_traces = self.retrieval_traces.read().unwrap();
        let citations = self.citations.read().unwrap();
        let mut files: HashMap<Uuid, FileAccumulator> = HashMap::new();

        for message in messages
            .iter()
            .filter(|message| message.role == MessageRole::User)
        {
            let Some(traces) = retrieval_traces.get(&message.id) else {
                continue;
            };
            let mut docs_in_turn = HashSet::new();
            for trace in traces {
                let entry = files
                    .entry(trace.doc_id)
                    .or_insert_with(|| FileAccumulator::from_retrieval(trace, message));
                if docs_in_turn.insert(trace.doc_id) {
                    entry.file.retrieval_count += 1;
                }
                entry.record_retrieval(trace, message);
            }
        }

        for message in messages
            .iter()
            .filter(|message| message.role == MessageRole::Assistant)
        {
            let Some(message_citations) = citations.get(&message.id) else {
                continue;
            };
            for citation in message_citations {
                let entry = files
                    .entry(citation.doc_id)
                    .or_insert_with(|| FileAccumulator::from_citation(citation, message));
                entry.record_citation(citation, message);
            }
        }

        let mut result: Vec<ConversationFile> =
            files.into_values().map(|entry| entry.file).collect();
        result.sort_by(|left, right| {
            right
                .last_used_at
                .cmp(&left.last_used_at)
                .then_with(|| left.doc_title.cmp(&right.doc_title))
        });
        Ok(result)
    }
}

struct FileAccumulator {
    file: ConversationFile,
    preview_at: chrono::DateTime<chrono::Utc>,
    preview_is_citation: bool,
}

impl FileAccumulator {
    fn from_retrieval(
        trace: &crate::models::trace::RetrievalTrace,
        message: &ConversationMessage,
    ) -> Self {
        let short_id = trace.doc_id.to_string();
        Self {
            file: ConversationFile {
                doc_id: trace.doc_id,
                doc_title: format!("文档 {}", &short_id[..8]),
                file_name: format!("文档 {}", &short_id[..8]),
                file_type: "unknown".to_string(),
                kb_id: None,
                kb_name: None,
                source_status: "available".to_string(),
                retrieval_count: 0,
                citation_count: 0,
                last_used_at: message.created_at,
                preview_page_range: trace.page_range.clone(),
                preview_quote: trace.content_preview.clone(),
                preview_anchor: None,
            },
            preview_at: message.created_at,
            preview_is_citation: false,
        }
    }

    fn from_citation(
        citation: &crate::models::citation::Citation,
        message: &ConversationMessage,
    ) -> Self {
        Self {
            file: ConversationFile {
                doc_id: citation.doc_id,
                doc_title: citation.doc_title.clone(),
                file_name: citation.doc_title.clone(),
                file_type: citation_file_type(citation),
                kb_id: None,
                kb_name: None,
                source_status: citation.source_status.clone(),
                retrieval_count: 0,
                citation_count: 0,
                last_used_at: message.created_at,
                preview_page_range: citation.page_range.clone(),
                preview_quote: citation.quote.clone(),
                preview_anchor: citation.anchor.clone(),
            },
            preview_at: message.created_at,
            preview_is_citation: true,
        }
    }

    fn record_retrieval(
        &mut self,
        trace: &crate::models::trace::RetrievalTrace,
        message: &ConversationMessage,
    ) {
        self.file.last_used_at = self.file.last_used_at.max(message.created_at);
        if !self.preview_is_citation && message.created_at >= self.preview_at {
            self.file.preview_page_range = trace.page_range.clone();
            self.file.preview_quote = trace.content_preview.clone();
            self.preview_at = message.created_at;
        }
    }

    fn record_citation(
        &mut self,
        citation: &crate::models::citation::Citation,
        message: &ConversationMessage,
    ) {
        self.file.citation_count += 1;
        self.file.doc_title = citation.doc_title.clone();
        self.file.file_name = citation.doc_title.clone();
        self.file.file_type = citation_file_type(citation);
        self.file.source_status = citation.source_status.clone();
        self.file.last_used_at = self.file.last_used_at.max(message.created_at);
        if !self.preview_is_citation || message.created_at >= self.preview_at {
            self.file.preview_page_range = citation.page_range.clone();
            self.file.preview_quote = citation.quote.clone();
            self.file.preview_anchor = citation.anchor.clone();
            self.preview_at = message.created_at;
            self.preview_is_citation = true;
        }
    }
}

fn citation_file_type(citation: &crate::models::citation::Citation) -> String {
    citation
        .anchor
        .as_ref()
        .map(|anchor| anchor.format.trim())
        .filter(|format| !format.is_empty())
        .map(str::to_string)
        .or_else(|| {
            citation
                .doc_title
                .rsplit_once('.')
                .map(|(_, extension)| extension.to_lowercase())
        })
        .unwrap_or_else(|| "unknown".to_string())
}

const CONVERSATION_FILES_SQL: &str = r#"
WITH source_rows AS (
    SELECT
        rt.id AS source_id,
        'retrieval'::text AS source_kind,
        rt.message_id AS source_message_id,
        rt.doc_id,
        rt.page_range,
        rt.content_preview AS quote,
        rt.score,
        NULL::jsonb AS anchor,
        NULL::text AS snapshot_title,
        m.created_at AS used_at
    FROM conversation_retrieval_traces rt
    JOIN conversation_messages m ON m.id = rt.message_id
    WHERE m.tenant_id = $1 AND m.conversation_id = $2

    UNION ALL

    SELECT
        c.id,
        'citation'::text,
        c.assistant_message_id,
        c.doc_id,
        c.page_range,
        c.quote,
        c.score,
        c.anchor,
        c.doc_title,
        m.created_at
    FROM conversation_citations c
    JOIN conversation_messages m ON m.id = c.assistant_message_id
    WHERE m.tenant_id = $1 AND m.conversation_id = $2
),
source_counts AS (
    SELECT
        doc_id,
        COUNT(DISTINCT source_message_id)
            FILTER (WHERE source_kind = 'retrieval') AS retrieval_count,
        COUNT(DISTINCT source_id)
            FILTER (WHERE source_kind = 'citation') AS citation_count,
        MAX(used_at) AS last_used_at
    FROM source_rows
    GROUP BY doc_id
),
preview_rows AS (
    SELECT DISTINCT ON (doc_id)
        doc_id, source_kind, page_range, quote, anchor, snapshot_title
    FROM source_rows
    ORDER BY doc_id, (source_kind = 'citation') DESC, used_at DESC, score DESC
)
SELECT
    counts.doc_id,
    COALESCE(d.title, preview.snapshot_title, '已删除文档') AS doc_title,
    COALESCE(
        NULLIF(d.metadata->>'original_filename', ''),
        NULLIF(d.storage_key, ''),
        d.title,
        preview.snapshot_title,
        '已删除文档'
    ) AS file_name,
    COALESCE(
        NULLIF(d.file_type, ''),
        NULLIF(preview.anchor->>'format', ''),
        'unknown'
    ) AS file_type,
    d.kb_id,
    kb.name AS kb_name,
    CASE
        WHEN d.id IS NULL OR d.parse_status = 'deleted' THEN 'deleted'
        ELSE 'available'
    END AS source_status,
    counts.retrieval_count,
    counts.citation_count,
    counts.last_used_at,
    preview.page_range AS preview_page_range,
    preview.quote AS preview_quote,
    preview.anchor AS preview_anchor
FROM source_counts counts
JOIN preview_rows preview ON preview.doc_id = counts.doc_id
LEFT JOIN documents d ON d.id = counts.doc_id AND d.tenant_id = $1
LEFT JOIN knowledge_base kb ON kb.id = d.kb_id AND kb.tenant_id = $1
WHERE d.kb_id = ANY($3) OR (d.id IS NULL AND preview.source_kind = 'citation')
ORDER BY counts.last_used_at DESC, doc_title ASC
"#;

#[cfg(test)]
#[path = "conversation_files_tests.rs"]
mod tests;
