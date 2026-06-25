use async_trait::async_trait;
use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx::{Pool, Postgres, Row};
use uuid::Uuid;

use crate::models::agent::AgentTrace;
use crate::models::citation::Citation;
use crate::models::conversation::{
    ConversationListItem, ConversationListResponse, ConversationSession,
};
use crate::models::feedback::Feedback;
use crate::models::message::ConversationMessage;
use crate::models::trace::{QueryTrace, RetrievalSource, RetrievalTrace};
use crate::models::{ConversationStatus, MessageRole, MessageStatus};

use super::trait_repo::ConversationRepository;

pub struct SqlxConversationRepository {
    pool: Pool<Postgres>,
}

impl SqlxConversationRepository {
    pub fn new(pool: Pool<Postgres>) -> Self {
        Self { pool }
    }
}

fn opt_uuid_list(value: Option<Vec<Uuid>>) -> Vec<Uuid> {
    value.unwrap_or_default()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[async_trait]
impl ConversationRepository for SqlxConversationRepository {
    async fn create_session(&self, session: ConversationSession) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO conversation_sessions (id, tenant_id, user_id, title, kb_ids, status, summary, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(session.id)
        .bind(session.tenant_id)
        .bind(session.user_id)
        .bind(session.title)
        .bind(&session.kb_ids)
        .bind(session.status.to_string())
        .bind(session.summary)
        .bind(session.created_at)
        .bind(session.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn list_sessions(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        limit: usize,
        cursor: Option<String>,
    ) -> anyhow::Result<ConversationListResponse> {
        let offset = cursor.and_then(|c| c.parse::<usize>().ok()).unwrap_or(0);
        let rows = sqlx::query(
            "SELECT s.id, s.title, s.updated_at,
                    (SELECT m.content FROM conversation_messages m
                     WHERE m.conversation_id = s.id AND m.role = 'user' AND m.status = 'completed'
                     ORDER BY m.created_at DESC LIMIT 1) as last_preview
             FROM conversation_sessions s
             WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.status = 'active'
             ORDER BY s.updated_at DESC
             LIMIT $3 OFFSET $4",
        )
        .bind(tenant_id)
        .bind(user_id)
        .bind(limit as i64 + 1)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await?;

        let mut items = Vec::with_capacity(rows.len());
        for row in &rows {
            items.push(ConversationListItem {
                conversation_id: row.try_get("id")?,
                title: row.try_get("title")?,
                last_message_preview: row.try_get("last_preview").ok(),
                updated_at: row.try_get("updated_at")?,
            });
        }

        let has_more = items.len() > limit;
        let items = items.into_iter().take(limit).collect();
        let next_cursor = if has_more {
            Some((offset + limit).to_string())
        } else {
            None
        };

        Ok(ConversationListResponse { items, next_cursor })
    }

    async fn get_session(
        &self,
        tenant_id: Uuid,
        conversation_id: Uuid,
    ) -> anyhow::Result<Option<ConversationSession>> {
        let row = sqlx::query(
            "SELECT id, tenant_id, user_id, title, kb_ids, status, summary, created_at, updated_at
             FROM conversation_sessions
             WHERE id = $1 AND tenant_id = $2",
        )
        .bind(conversation_id)
        .bind(tenant_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| ConversationSession {
            id: r.try_get("id").unwrap(),
            tenant_id: r.try_get("tenant_id").unwrap(),
            user_id: r.try_get("user_id").unwrap(),
            title: r.try_get("title").unwrap(),
            kb_ids: opt_uuid_list(r.try_get("kb_ids").ok()),
            status: r
                .try_get::<String, _>("status")
                .unwrap()
                .parse()
                .unwrap_or(ConversationStatus::Active),
            summary: r.try_get("summary").ok(),
            created_at: r.try_get("created_at").unwrap(),
            updated_at: r.try_get("updated_at").unwrap(),
        }))
    }

    async fn update_session(&self, session: ConversationSession) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE conversation_sessions
             SET title = $1, kb_ids = $2, status = $3, summary = $4, updated_at = $5
             WHERE id = $6 AND tenant_id = $7",
        )
        .bind(session.title)
        .bind(&session.kb_ids)
        .bind(session.status.to_string())
        .bind(session.summary)
        .bind(session.updated_at)
        .bind(session.id)
        .bind(session.tenant_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn create_message(&self, message: ConversationMessage) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO conversation_messages (
                id, conversation_id, tenant_id, user_id, role, content, status,
                parent_message_id, retry_of_message_id, client_request_id,
                confidence, no_answer_reason, error_code, error_message,
                agent_mode, prompt_versions, created_at, completed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
        )
        .bind(message.id)
        .bind(message.conversation_id)
        .bind(message.tenant_id)
        .bind(message.user_id)
        .bind(message.role.to_string())
        .bind(message.content)
        .bind(message.status.to_string())
        .bind(message.parent_message_id)
        .bind(message.retry_of_message_id)
        .bind(message.client_request_id.clone())
        .bind(message.confidence.map(|c| c.to_string()))
        .bind(message.no_answer_reason.map(|r| r.to_string()))
        .bind(message.error_code)
        .bind(message.error_message)
        .bind(message.agent_mode.map(|m| m.to_string()))
        .bind(message.prompt_versions.map(|p| serde_json::to_value(p).unwrap()))
        .bind(message.created_at)
        .bind(message.completed_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn get_message(
        &self,
        tenant_id: Uuid,
        message_id: Uuid,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        let row = sqlx::query(
            "SELECT id, conversation_id, tenant_id, user_id, role, content, status,
                    parent_message_id, retry_of_message_id, client_request_id,
                    confidence, no_answer_reason, error_code, error_message,
                    agent_mode, prompt_versions, created_at, completed_at
             FROM conversation_messages
             WHERE id = $1 AND tenant_id = $2",
        )
        .bind(message_id)
        .bind(tenant_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(parse_message).transpose()?)
    }

    async fn get_messages(
        &self,
        tenant_id: Uuid,
        conversation_id: Uuid,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        let rows = sqlx::query(
            "SELECT id, conversation_id, tenant_id, user_id, role, content, status,
                    parent_message_id, retry_of_message_id, client_request_id,
                    confidence, no_answer_reason, error_code, error_message,
                    agent_mode, prompt_versions, created_at, completed_at
             FROM conversation_messages
             WHERE conversation_id = $1 AND tenant_id = $2
             ORDER BY created_at ASC",
        )
        .bind(conversation_id)
        .bind(tenant_id)
        .fetch_all(&self.pool)
        .await?;

        let mut messages = Vec::with_capacity(rows.len());
        for row in rows {
            messages.push(parse_message(row)?);
        }
        Ok(messages)
    }

    async fn update_message(&self, message: ConversationMessage) -> anyhow::Result<()> {
        sqlx::query(
            "UPDATE conversation_messages
             SET content = $1, status = $2, parent_message_id = $3, retry_of_message_id = $4,
                 client_request_id = $5, confidence = $6, no_answer_reason = $7,
                 error_code = $8, error_message = $9, agent_mode = $10, prompt_versions = $11,
                 created_at = $12, completed_at = $13
             WHERE id = $14 AND tenant_id = $15",
        )
        .bind(message.content)
        .bind(message.status.to_string())
        .bind(message.parent_message_id)
        .bind(message.retry_of_message_id)
        .bind(message.client_request_id.clone())
        .bind(message.confidence.map(|c| c.to_string()))
        .bind(message.no_answer_reason.map(|r| r.to_string()))
        .bind(message.error_code)
        .bind(message.error_message)
        .bind(message.agent_mode.map(|m| m.to_string()))
        .bind(
            message
                .prompt_versions
                .map(|p| serde_json::to_value(p).unwrap()),
        )
        .bind(message.created_at)
        .bind(message.completed_at)
        .bind(message.id)
        .bind(message.tenant_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn find_message_by_client_request_id(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        client_request_id: &str,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        let row = sqlx::query(
            "SELECT id, conversation_id, tenant_id, user_id, role, content, status,
                    parent_message_id, retry_of_message_id, client_request_id,
                    confidence, no_answer_reason, error_code, error_message,
                    agent_mode, prompt_versions, created_at, completed_at
             FROM conversation_messages
             WHERE tenant_id = $1 AND user_id = $2 AND client_request_id = $3",
        )
        .bind(tenant_id)
        .bind(user_id)
        .bind(client_request_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(parse_message).transpose()?)
    }

    async fn save_query_trace(&self, trace: QueryTrace) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO conversation_query_traces (
                id, message_id, original_query, rewritten_query, keywords,
                hypothetical_answer, resolved_refs, effective_kb_ids, rewrite_model, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(trace.id)
        .bind(trace.message_id)
        .bind(trace.original_query)
        .bind(trace.rewritten_query)
        .bind(&trace.keywords)
        .bind(trace.hypothetical_answer)
        .bind(serde_json::to_value(&trace.resolved_refs).unwrap())
        .bind(&trace.effective_kb_ids)
        .bind(trace.rewrite_model)
        .bind(trace.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn get_query_trace(&self, message_id: Uuid) -> anyhow::Result<Option<QueryTrace>> {
        let row = sqlx::query(
            "SELECT id, message_id, original_query, rewritten_query, keywords,
                    hypothetical_answer, resolved_refs, effective_kb_ids, rewrite_model, created_at
             FROM conversation_query_traces
             WHERE message_id = $1",
        )
        .bind(message_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| QueryTrace {
            id: r.try_get("id").unwrap(),
            message_id: r.try_get("message_id").unwrap(),
            original_query: r.try_get("original_query").unwrap(),
            rewritten_query: r.try_get("rewritten_query").ok(),
            keywords: opt_string_list(r.try_get("keywords").ok()),
            hypothetical_answer: r.try_get("hypothetical_answer").ok(),
            resolved_refs: serde_json::from_value(
                r.try_get("resolved_refs")
                    .unwrap_or(serde_json::Value::Array(vec![])),
            )
            .unwrap_or_default(),
            effective_kb_ids: opt_uuid_list(r.try_get("effective_kb_ids").ok()),
            rewrite_model: r.try_get("rewrite_model").unwrap(),
            created_at: r.try_get("created_at").unwrap(),
        }))
    }

    async fn save_retrieval_traces(&self, traces: Vec<RetrievalTrace>) -> anyhow::Result<()> {
        for trace in traces {
            sqlx::query(
                "INSERT INTO conversation_retrieval_traces (
                    id, message_id, chunk_id, doc_id, source, rank, score,
                    heading_path, page_range, content_preview
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            )
            .bind(trace.id)
            .bind(trace.message_id)
            .bind(trace.chunk_id)
            .bind(trace.doc_id)
            .bind(trace.source.to_string())
            .bind(trace.rank)
            .bind(trace.score)
            .bind(serde_json::to_value(&trace.heading_path).unwrap())
            .bind(&trace.page_range)
            .bind(trace.content_preview)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    async fn get_retrieval_traces(&self, message_id: Uuid) -> anyhow::Result<Vec<RetrievalTrace>> {
        let rows = sqlx::query(
            "SELECT id, message_id, chunk_id, doc_id, source, rank, score,
                    heading_path, page_range, content_preview
             FROM conversation_retrieval_traces
             WHERE message_id = $1
             ORDER BY rank ASC",
        )
        .bind(message_id)
        .fetch_all(&self.pool)
        .await?;

        let mut traces = Vec::with_capacity(rows.len());
        for row in rows {
            traces.push(RetrievalTrace {
                id: row.try_get("id").unwrap(),
                message_id: row.try_get("message_id").unwrap(),
                chunk_id: row.try_get("chunk_id").unwrap(),
                doc_id: row.try_get("doc_id").unwrap(),
                source: row
                    .try_get::<String, _>("source")
                    .unwrap()
                    .parse()
                    .unwrap_or(RetrievalSource::Rerank),
                rank: row.try_get("rank").unwrap(),
                score: row.try_get("score").unwrap(),
                heading_path: serde_json::from_value(
                    row.try_get("heading_path")
                        .unwrap_or(serde_json::Value::Array(vec![])),
                )
                .unwrap_or_default(),
                page_range: opt_i32_list(row.try_get("page_range").ok()),
                content_preview: row.try_get("content_preview").unwrap(),
            });
        }
        Ok(traces)
    }

    async fn save_citations(&self, citations: Vec<Citation>) -> anyhow::Result<()> {
        for citation in citations {
            sqlx::query(
                "INSERT INTO conversation_citations (
                    id, assistant_message_id, index, chunk_id, doc_id, doc_title,
                    page_range, heading_path, quote, score, anchor, location_status
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            )
            .bind(citation.id)
            .bind(citation.assistant_message_id)
            .bind(citation.index)
            .bind(citation.chunk_id)
            .bind(citation.doc_id)
            .bind(citation.doc_title)
            .bind(&citation.page_range)
            .bind(serde_json::to_value(&citation.heading_path).unwrap())
            .bind(citation.quote)
            .bind(citation.score)
            .bind(serde_json::to_value(&citation.anchor).unwrap_or(serde_json::Value::Null))
            .bind(
                citation
                    .anchor
                    .as_ref()
                    .map(|anchor| anchor.location_status.as_str())
                    .unwrap_or("unavailable"),
            )
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    async fn get_citations(&self, assistant_message_id: Uuid) -> anyhow::Result<Vec<Citation>> {
        let rows = sqlx::query(
            "SELECT c.id, c.assistant_message_id, c.index, c.chunk_id, c.doc_id, c.doc_title,
                    c.page_range, c.heading_path, c.quote, c.score, c.anchor,
                    CASE
                        WHEN d.id IS NULL THEN 'deleted'
                        WHEN d.parse_status = 'deleted' THEN 'deleted'
                        ELSE 'available'
                    END AS source_status
             FROM conversation_citations c
             LEFT JOIN documents d ON d.id = c.doc_id
             WHERE assistant_message_id = $1
             ORDER BY index ASC",
        )
        .bind(assistant_message_id)
        .fetch_all(&self.pool)
        .await?;

        let mut citations = Vec::with_capacity(rows.len());
        for row in rows {
            citations.push(Citation {
                id: row.try_get("id").unwrap(),
                assistant_message_id: row.try_get("assistant_message_id").unwrap(),
                index: row.try_get("index").unwrap(),
                chunk_id: row.try_get("chunk_id").unwrap(),
                doc_id: row.try_get("doc_id").unwrap(),
                doc_title: row.try_get("doc_title").unwrap(),
                page_range: opt_i32_list(row.try_get("page_range").ok()),
                heading_path: serde_json::from_value(
                    row.try_get("heading_path")
                        .unwrap_or(serde_json::Value::Array(vec![])),
                )
                .unwrap_or_default(),
                quote: row.try_get("quote").unwrap(),
                score: row.try_get("score").unwrap(),
                source_status: row.try_get("source_status").unwrap(),
                anchor: row
                    .try_get::<Option<serde_json::Value>, _>("anchor")
                    .ok()
                    .flatten()
                    .and_then(|value| serde_json::from_value(value).ok()),
            });
        }
        Ok(citations)
    }

    async fn save_agent_trace(
        &self,
        assistant_message_id: Uuid,
        trace: AgentTrace,
    ) -> anyhow::Result<()> {
        let value = serde_json::to_value(trace)?;
        sqlx::query(
            "INSERT INTO conversation_agent_traces (assistant_message_id, trace, created_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (assistant_message_id) DO UPDATE SET trace = EXCLUDED.trace, created_at = EXCLUDED.created_at",
        )
        .bind(assistant_message_id)
        .bind(value)
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn get_agent_trace(
        &self,
        assistant_message_id: Uuid,
    ) -> anyhow::Result<Option<AgentTrace>> {
        let row = sqlx::query(
            "SELECT trace FROM conversation_agent_traces WHERE assistant_message_id = $1",
        )
        .bind(assistant_message_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| {
            let value: serde_json::Value = r.try_get("trace").unwrap();
            serde_json::from_value(value).unwrap()
        }))
    }

    async fn doc_version_hash(&self, tenant_id: Uuid, kb_ids: &[Uuid]) -> anyhow::Result<String> {
        if kb_ids.is_empty() {
            return Ok("empty-scope".to_string());
        }

        let row = sqlx::query(
            "WITH live_chunks AS (
                SELECT doc_id,
                       COUNT(*) AS chunk_count,
                       MAX(created_at) AS max_chunk_created_at
                FROM chunks
                WHERE tenant_id = $1
                  AND kb_id = ANY($2)
                GROUP BY doc_id
             ),
             scope_docs AS (
                SELECT d.id,
                       d.kb_id,
                       d.file_sha256,
                       d.parse_status,
                       d.parse_version,
                       d.latest_parse_job_id,
                       d.updated_at,
                       COALESCE(lc.chunk_count, 0) AS chunk_count,
                       lc.max_chunk_created_at
                FROM documents d
                LEFT JOIN live_chunks lc ON lc.doc_id = d.id
                WHERE d.tenant_id = $1
                  AND d.kb_id = ANY($2)
             )
             SELECT COALESCE(
                string_agg(
                    concat_ws('|',
                        id::text,
                        kb_id::text,
                        file_sha256,
                        parse_status,
                        parse_version::text,
                        COALESCE(latest_parse_job_id::text, ''),
                        updated_at::text,
                        chunk_count::text,
                        COALESCE(max_chunk_created_at::text, '')
                    ),
                    E'\n'
                    ORDER BY kb_id, id
                ),
                'no-documents'
             ) AS version_input
             FROM scope_docs",
        )
        .bind(tenant_id)
        .bind(kb_ids)
        .fetch_one(&self.pool)
        .await?;

        let version_input: String = row.try_get("version_input")?;
        Ok(sha256_hex(version_input.as_bytes()))
    }

    async fn save_feedback(&self, feedback: Feedback) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO conversation_feedback (
                id, assistant_message_id, user_id, rating, reason, comment, correction, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(feedback.id)
        .bind(feedback.assistant_message_id)
        .bind(feedback.user_id)
        .bind(feedback.rating.to_string())
        .bind(feedback.reason.map(|r| r.to_string()))
        .bind(feedback.comment)
        .bind(feedback.correction)
        .bind(feedback.created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn parse_message(row: sqlx::postgres::PgRow) -> anyhow::Result<ConversationMessage> {
    let prompt_json: Option<serde_json::Value> = row.try_get("prompt_versions").ok();
    let prompt_versions = prompt_json.and_then(|v| serde_json::from_value(v).ok());

    Ok(ConversationMessage {
        id: row.try_get("id")?,
        conversation_id: row.try_get("conversation_id")?,
        tenant_id: row.try_get("tenant_id")?,
        user_id: row.try_get("user_id")?,
        role: row
            .try_get::<String, _>("role")?
            .parse()
            .unwrap_or(MessageRole::User),
        content: row.try_get("content")?,
        status: row
            .try_get::<String, _>("status")?
            .parse()
            .unwrap_or(MessageStatus::Created),
        parent_message_id: row.try_get("parent_message_id").ok(),
        retry_of_message_id: row.try_get("retry_of_message_id").ok(),
        client_request_id: row.try_get("client_request_id").ok(),
        confidence: row
            .try_get::<String, _>("confidence")
            .ok()
            .and_then(|s| s.parse().ok()),
        no_answer_reason: row
            .try_get::<String, _>("no_answer_reason")
            .ok()
            .and_then(|s| s.parse().ok()),
        error_code: row.try_get("error_code").ok(),
        error_message: row.try_get("error_message").ok(),
        agent_mode: row
            .try_get::<String, _>("agent_mode")
            .ok()
            .and_then(|s| s.parse().ok()),
        prompt_versions,
        created_at: row.try_get("created_at")?,
        completed_at: row.try_get("completed_at").ok(),
    })
}

fn opt_string_list(value: Option<Vec<String>>) -> Vec<String> {
    value.unwrap_or_default()
}

fn opt_i32_list(value: Option<Vec<i32>>) -> Vec<i32> {
    value.unwrap_or_default()
}
