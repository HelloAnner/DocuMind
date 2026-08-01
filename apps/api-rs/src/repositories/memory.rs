use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use uuid::Uuid;

use crate::models::agent::{AgentTrace, CitationOutput};
use crate::models::citation::Citation;
use crate::models::conversation::{
    ConversationListItem, ConversationListResponse, ConversationSession,
};
use crate::models::conversation_file::ConversationFile;
use crate::models::feedback::Feedback;
use crate::models::message::ConversationMessage;
use crate::models::trace::{QueryTrace, RetrievalTrace};
use crate::models::ConversationStatus;

use super::trait_repo::ConversationRepository;

type ClientRequestMap = HashMap<(Uuid, Uuid, String), Uuid>;

pub struct InMemoryConversationRepository {
    sessions: Arc<RwLock<HashMap<Uuid, ConversationSession>>>,
    title_locks: Arc<RwLock<HashSet<Uuid>>>,
    pub(super) messages: Arc<RwLock<HashMap<Uuid, ConversationMessage>>>,
    client_request_ids: Arc<RwLock<ClientRequestMap>>,
    query_traces: Arc<RwLock<HashMap<Uuid, QueryTrace>>>,
    pub(super) retrieval_traces: Arc<RwLock<HashMap<Uuid, Vec<RetrievalTrace>>>>,
    pub(super) citations: Arc<RwLock<HashMap<Uuid, Vec<Citation>>>>,
    agent_traces: Arc<RwLock<HashMap<Uuid, AgentTrace>>>,
    feedback: Arc<RwLock<HashMap<(Uuid, Uuid), Feedback>>>,
}

impl Default for InMemoryConversationRepository {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryConversationRepository {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            title_locks: Arc::new(RwLock::new(HashSet::new())),
            messages: Arc::new(RwLock::new(HashMap::new())),
            client_request_ids: Arc::new(RwLock::new(HashMap::new())),
            query_traces: Arc::new(RwLock::new(HashMap::new())),
            retrieval_traces: Arc::new(RwLock::new(HashMap::new())),
            citations: Arc::new(RwLock::new(HashMap::new())),
            agent_traces: Arc::new(RwLock::new(HashMap::new())),
            feedback: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl ConversationRepository for InMemoryConversationRepository {
    async fn create_session(&self, session: ConversationSession) -> anyhow::Result<()> {
        if session.title.trim() != "新会话" {
            self.title_locks.write().unwrap().insert(session.id);
        }
        let mut sessions = self.sessions.write().unwrap();
        sessions.insert(session.id, session);
        Ok(())
    }

    async fn list_sessions(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        limit: usize,
        cursor: Option<String>,
    ) -> anyhow::Result<ConversationListResponse> {
        let sessions = self.sessions.read().unwrap();
        let offset = cursor.and_then(|c| c.parse::<usize>().ok()).unwrap_or(0);

        let mut list: Vec<&ConversationSession> = sessions
            .values()
            .filter(|s| {
                s.tenant_id == tenant_id
                    && s.user_id == user_id
                    && s.status == ConversationStatus::Active
            })
            .collect();
        list.sort_by_key(|s| std::cmp::Reverse(s.updated_at));

        let _total = list.len();
        let page: Vec<ConversationListItem> = list
            .into_iter()
            .skip(offset)
            .take(limit + 1)
            .map(|s| {
                let preview = self
                    .messages
                    .read()
                    .unwrap()
                    .values()
                    .filter(|m| {
                        m.conversation_id == s.id
                            && m.role == crate::models::MessageRole::User
                            && m.status == crate::models::MessageStatus::Completed
                    })
                    .max_by_key(|m| m.created_at)
                    .map(|m| m.content.clone());
                ConversationListItem {
                    conversation_id: s.id,
                    title: s.title.clone(),
                    last_message_preview: preview,
                    updated_at: s.updated_at,
                }
            })
            .collect();

        let has_more = page.len() > limit;
        let items = page.into_iter().take(limit).collect();
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
        let sessions = self.sessions.read().unwrap();
        Ok(sessions
            .get(&conversation_id)
            .filter(|s| s.tenant_id == tenant_id)
            .cloned())
    }

    async fn update_session(&self, session: ConversationSession) -> anyhow::Result<()> {
        let mut sessions = self.sessions.write().unwrap();
        sessions.insert(session.id, session);
        Ok(())
    }

    async fn update_session_title(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        conversation_id: Uuid,
        title: &str,
        manual: bool,
    ) -> anyhow::Result<bool> {
        let mut locks = self.title_locks.write().unwrap();
        if !manual && locks.contains(&conversation_id) {
            return Ok(false);
        }
        let mut sessions = self.sessions.write().unwrap();
        let Some(session) = sessions.get_mut(&conversation_id) else {
            return Ok(false);
        };
        if session.tenant_id != tenant_id
            || session.user_id != user_id
            || session.status != ConversationStatus::Active
        {
            return Ok(false);
        }
        session.title = title.to_string();
        session.updated_at = crate::models::now();
        if manual {
            locks.insert(conversation_id);
        }
        Ok(true)
    }

    async fn create_message(&self, message: ConversationMessage) -> anyhow::Result<()> {
        let mut messages = self.messages.write().unwrap();
        if let Some(ref req_id) = message.client_request_id {
            let mut cr = self.client_request_ids.write().unwrap();
            cr.insert(
                (message.tenant_id, message.user_id, req_id.clone()),
                message.id,
            );
        }
        messages.insert(message.id, message);
        Ok(())
    }

    async fn get_message(
        &self,
        tenant_id: Uuid,
        message_id: Uuid,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        let messages = self.messages.read().unwrap();
        Ok(messages
            .get(&message_id)
            .filter(|m| m.tenant_id == tenant_id)
            .cloned())
    }

    async fn get_messages(
        &self,
        tenant_id: Uuid,
        conversation_id: Uuid,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        let messages = self.messages.read().unwrap();
        let mut list: Vec<ConversationMessage> = messages
            .values()
            .filter(|m| m.conversation_id == conversation_id && m.tenant_id == tenant_id)
            .cloned()
            .collect();
        list.sort_by_key(|m| m.created_at);
        Ok(list)
    }

    async fn update_message(&self, message: ConversationMessage) -> anyhow::Result<()> {
        let mut messages = self.messages.write().unwrap();
        messages.insert(message.id, message);
        Ok(())
    }

    async fn find_message_by_client_request_id(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        client_request_id: &str,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        let id = {
            let cr = self.client_request_ids.read().unwrap();
            cr.get(&(tenant_id, user_id, client_request_id.to_string()))
                .copied()
        };
        if let Some(id) = id {
            self.get_message(tenant_id, id).await
        } else {
            Ok(None)
        }
    }

    async fn save_query_trace(&self, trace: QueryTrace) -> anyhow::Result<()> {
        let mut qt = self.query_traces.write().unwrap();
        qt.insert(trace.message_id, trace);
        Ok(())
    }

    async fn get_query_trace(&self, message_id: Uuid) -> anyhow::Result<Option<QueryTrace>> {
        let qt = self.query_traces.read().unwrap();
        Ok(qt.get(&message_id).cloned())
    }

    async fn save_retrieval_traces(&self, traces: Vec<RetrievalTrace>) -> anyhow::Result<()> {
        let mut rt = self.retrieval_traces.write().unwrap();
        if let Some(first) = traces.first() {
            rt.insert(first.message_id, traces);
        }
        Ok(())
    }

    async fn get_retrieval_traces(&self, message_id: Uuid) -> anyhow::Result<Vec<RetrievalTrace>> {
        let rt = self.retrieval_traces.read().unwrap();
        Ok(rt.get(&message_id).cloned().unwrap_or_default())
    }

    async fn save_citations(&self, citations: Vec<Citation>) -> anyhow::Result<()> {
        let mut ct = self.citations.write().unwrap();
        if let Some(first) = citations.first() {
            ct.insert(first.assistant_message_id, citations);
        }
        Ok(())
    }

    async fn get_citations(&self, assistant_message_id: Uuid) -> anyhow::Result<Vec<Citation>> {
        let ct = self.citations.read().unwrap();
        Ok(ct.get(&assistant_message_id).cloned().unwrap_or_default())
    }

    async fn save_agent_trace(
        &self,
        assistant_message_id: Uuid,
        trace: AgentTrace,
    ) -> anyhow::Result<()> {
        let mut at = self.agent_traces.write().unwrap();
        at.insert(assistant_message_id, trace);
        Ok(())
    }

    async fn get_agent_trace(
        &self,
        assistant_message_id: Uuid,
    ) -> anyhow::Result<Option<AgentTrace>> {
        let at = self.agent_traces.read().unwrap();
        Ok(at.get(&assistant_message_id).cloned())
    }

    async fn doc_version_hash(&self, _tenant_id: Uuid, kb_ids: &[Uuid]) -> anyhow::Result<String> {
        let mut kb_sorted: Vec<String> = kb_ids.iter().map(|id| id.to_string()).collect();
        kb_sorted.sort();
        Ok(format!("memory:{}", kb_sorted.join(",")))
    }

    async fn citations_valid_for_scope(
        &self,
        _tenant_id: Uuid,
        kb_ids: &[Uuid],
        citations: &[CitationOutput],
    ) -> anyhow::Result<bool> {
        Ok(!kb_ids.is_empty() && !citations.is_empty())
    }

    async fn upsert_feedback(&self, mut feedback: Feedback) -> anyhow::Result<Feedback> {
        let mut fb = self.feedback.write().unwrap();
        let key = (feedback.assistant_message_id, feedback.user_id);
        if let Some(existing) = fb.get(&key) {
            feedback.id = existing.id;
            feedback.created_at = existing.created_at;
        }
        fb.insert(key, feedback.clone());
        Ok(feedback)
    }

    async fn get_feedback(
        &self,
        assistant_message_id: Uuid,
        user_id: Uuid,
    ) -> anyhow::Result<Option<Feedback>> {
        let fb = self.feedback.read().unwrap();
        Ok(fb.get(&(assistant_message_id, user_id)).cloned())
    }

    async fn delete_feedback(
        &self,
        assistant_message_id: Uuid,
        user_id: Uuid,
    ) -> anyhow::Result<bool> {
        let mut fb = self.feedback.write().unwrap();
        Ok(fb.remove(&(assistant_message_id, user_id)).is_some())
    }

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
        let citations = self.citations.read().unwrap();
        let mut files: HashMap<Uuid, FileAccumulator> = HashMap::new();

        for message in messages.iter().filter(|m| m.role == crate::models::MessageRole::Assistant) {
            let Some(msg_citations) = citations.get(&message.id) else { continue };
            for citation in msg_citations {
                let entry = files
                    .entry(citation.doc_id)
                    .or_insert_with(|| FileAccumulator::from_citation(citation, message));
                entry.record_citation(citation, message);
            }
        }

        let mut result: Vec<ConversationFile> = files.into_values().map(|e| e.file).collect();
        result.sort_by(|a, b| {
            b.last_used_at.cmp(&a.last_used_at).then_with(|| a.doc_title.cmp(&b.doc_title))
        });
        Ok(result)
    }
}

struct FileAccumulator {
    file: ConversationFile,
    preview_at: chrono::DateTime<chrono::Utc>,
}

impl FileAccumulator {
    fn from_citation(citation: &Citation, message: &ConversationMessage) -> Self {
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
        }
    }

    fn record_citation(&mut self, citation: &Citation, message: &ConversationMessage) {
        self.file.citation_count = 1;
        self.file.doc_title = citation.doc_title.clone();
        self.file.file_name = citation.doc_title.clone();
        self.file.file_type = citation_file_type(citation);
        self.file.source_status = citation.source_status.clone();
        self.file.last_used_at = self.file.last_used_at.max(message.created_at);
        if message.created_at >= self.preview_at {
            self.file.preview_page_range = citation.page_range.clone();
            self.file.preview_quote = citation.quote.clone();
            self.file.preview_anchor = citation.anchor.clone();
            self.preview_at = message.created_at;
        }
    }
}

fn citation_file_type(citation: &Citation) -> String {
    citation
        .anchor
        .as_ref()
        .map(|a| a.format.trim())
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .or_else(|| citation.doc_title.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()))
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::citation::{Citation, CitationAnchor};
    use crate::models::conversation::ConversationSession;
    use crate::models::feedback::Rating;
    use crate::models::message::ConversationMessage;
    use crate::models::now;
    use crate::models::trace::{RetrievalSource, RetrievalTrace};
    use crate::models::{ConversationStatus, MessageRole, MessageStatus};

    #[tokio::test]
    async fn test_session_and_message_crud() {
        let repo = InMemoryConversationRepository::new();
        let tenant = Uuid::new_v4();
        let user = Uuid::new_v4();
        let session = ConversationSession {
            id: Uuid::new_v4(),
            tenant_id: tenant,
            user_id: user,
            title: "测试会话".to_string(),
            kb_ids: vec![Uuid::new_v4()],
            status: ConversationStatus::Active,
            summary: None,
            created_at: now(),
            updated_at: now(),
        };
        repo.create_session(session.clone()).await.unwrap();
        let fetched = repo.get_session(tenant, session.id).await.unwrap();
        assert!(fetched.is_some());

        let msg = ConversationMessage {
            id: Uuid::new_v4(),
            conversation_id: session.id,
            tenant_id: tenant,
            user_id: user,
            role: MessageRole::User,
            content: "hello".to_string(),
            status: MessageStatus::Completed,
            parent_message_id: None,
            retry_of_message_id: None,
            client_request_id: Some("req-1".to_string()),
            confidence: None,
            no_answer_reason: None,
            error_code: None,
            error_message: None,
            agent_mode: None,
            prompt_versions: None,
            created_at: now(),
            completed_at: Some(now()),
        };
        repo.create_message(msg.clone()).await.unwrap();
        let dup = repo
            .find_message_by_client_request_id(tenant, user, "req-1")
            .await
            .unwrap();
        assert_eq!(dup.map(|m| m.id), Some(msg.id));
    }

    #[tokio::test]
    async fn manual_title_prevents_later_automatic_updates() {
        let repo = InMemoryConversationRepository::new();
        let tenant = Uuid::new_v4();
        let user = Uuid::new_v4();
        let session = ConversationSession {
            id: Uuid::new_v4(),
            tenant_id: tenant,
            user_id: user,
            title: "新会话".to_string(),
            kb_ids: vec![],
            status: ConversationStatus::Active,
            summary: None,
            created_at: now(),
            updated_at: now(),
        };
        repo.create_session(session.clone()).await.unwrap();

        assert!(repo
            .update_session_title(tenant, user, session.id, "手动标题", true)
            .await
            .unwrap());
        assert!(!repo
            .update_session_title(tenant, user, session.id, "自动标题", false)
            .await
            .unwrap());
        assert_eq!(
            repo.get_session(tenant, session.id)
                .await
                .unwrap()
                .unwrap()
                .title,
            "手动标题"
        );
    }

    #[tokio::test]
    async fn doc_version_hash_is_scope_order_independent() {
        let repo = InMemoryConversationRepository::new();
        let tenant = Uuid::new_v4();
        let kb_a = Uuid::parse_str("00000000-0000-0000-0000-000000000010").unwrap();
        let kb_b = Uuid::parse_str("00000000-0000-0000-0000-000000000011").unwrap();

        let first = repo.doc_version_hash(tenant, &[kb_a, kb_b]).await.unwrap();
        let second = repo.doc_version_hash(tenant, &[kb_b, kb_a]).await.unwrap();

        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn cached_citations_require_scope_and_sources() {
        let repo = InMemoryConversationRepository::new();
        let tenant = Uuid::new_v4();
        let kb_id = Uuid::new_v4();
        let citation = crate::models::agent::CitationOutput {
            index: 1,
            chunk_id: Uuid::new_v4(),
            doc_id: Uuid::new_v4(),
            doc_title: "测试文档".to_string(),
            page_range: vec![1],
            quote: "引用片段".to_string(),
            score: 0.9,
            source_status: "available".to_string(),
            anchor: None,
        };

        assert!(!repo
            .citations_valid_for_scope(tenant, &[kb_id], &[])
            .await
            .unwrap());
        assert!(!repo
            .citations_valid_for_scope(tenant, &[], std::slice::from_ref(&citation))
            .await
            .unwrap());
        assert!(repo
            .citations_valid_for_scope(tenant, &[kb_id], &[citation])
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn feedback_is_unique_per_message_and_user_and_can_be_removed() {
        let repo = InMemoryConversationRepository::new();
        let message_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let created_at = now();
        let original_id = Uuid::new_v4();

        repo.upsert_feedback(Feedback {
            id: original_id,
            assistant_message_id: message_id,
            user_id,
            rating: Rating::Up,
            reason: None,
            comment: None,
            correction: None,
            created_at,
            updated_at: created_at,
        })
        .await
        .unwrap();

        let updated_at = now();
        let updated = repo
            .upsert_feedback(Feedback {
                id: Uuid::new_v4(),
                assistant_message_id: message_id,
                user_id,
                rating: Rating::Down,
                reason: None,
                comment: Some("答案不够准确".to_string()),
                correction: None,
                created_at: updated_at,
                updated_at,
            })
            .await
            .unwrap();

        assert_eq!(updated.id, original_id);
        assert_eq!(updated.created_at, created_at);
        assert_eq!(updated.rating, Rating::Down);
        assert_eq!(updated.comment.as_deref(), Some("答案不够准确"));
        assert_eq!(
            repo.get_feedback(message_id, user_id)
                .await
                .unwrap()
                .map(|feedback| feedback.id),
            Some(original_id)
        );
        assert!(repo.delete_feedback(message_id, user_id).await.unwrap());
        assert!(repo
            .get_feedback(message_id, user_id)
            .await
            .unwrap()
            .is_none());
        assert!(!repo.delete_feedback(message_id, user_id).await.unwrap());
    }

    fn test_message(id: Uuid, conversation_id: Uuid, tenant_id: Uuid, user_id: Uuid, role: MessageRole) -> ConversationMessage {
        ConversationMessage {
            id, conversation_id, tenant_id, user_id, role,
            content: "测试消息".to_string(),
            status: MessageStatus::Completed,
            parent_message_id: None, retry_of_message_id: None,
            client_request_id: None, confidence: None,
            no_answer_reason: None, error_code: None, error_message: None,
            agent_mode: None, prompt_versions: None,
            created_at: now(), completed_at: Some(now()),
        }
    }

    fn test_retrieval(message_id: Uuid, doc_id: Uuid, page: i32, content_preview: &str) -> RetrievalTrace {
        RetrievalTrace {
            id: Uuid::new_v4(), message_id, chunk_id: Uuid::new_v4(), doc_id,
            source: RetrievalSource::Rerank, rank: page, score: 0.9,
            heading_path: vec![], page_range: vec![page],
            content_preview: content_preview.to_string(),
        }
    }

    #[tokio::test]
    async fn lists_only_uniquely_cited_documents() {
        let repo = InMemoryConversationRepository::new();
        let tenant_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let kb_id = Uuid::new_v4();
        let user_message_id = Uuid::new_v4();
        let assistant_message_id = Uuid::new_v4();
        let cited_doc_id = Uuid::new_v4();
        let retrieved_doc_id = Uuid::new_v4();
        let created_at = now();

        repo.create_session(ConversationSession {
            id: conversation_id, tenant_id, user_id,
            title: "文件聚合测试".to_string(), kb_ids: vec![kb_id],
            status: ConversationStatus::Active, summary: None,
            created_at, updated_at: created_at,
        }).await.unwrap();
        repo.create_message(test_message(user_message_id, conversation_id, tenant_id, user_id, MessageRole::User)).await.unwrap();
        repo.create_message(test_message(assistant_message_id, conversation_id, tenant_id, user_id, MessageRole::Assistant)).await.unwrap();

        repo.save_retrieval_traces(vec![
            test_retrieval(user_message_id, cited_doc_id, 1, "检索片段"),
            test_retrieval(user_message_id, cited_doc_id, 2, "重排片段"),
            test_retrieval(user_message_id, retrieved_doc_id, 3, "另一份相关文件"),
        ]).await.unwrap();
        repo.save_citations(vec![Citation {
            id: Uuid::new_v4(), assistant_message_id, index: 1,
            chunk_id: Uuid::new_v4(), doc_id: cited_doc_id,
            doc_title: "采购合同.pdf".to_string(), page_range: vec![8],
            heading_path: vec![], quote: "验收后支付尾款".to_string(),
            score: 0.95, source_status: "available".to_string(),
            anchor: Some(CitationAnchor {
                format: "pdf".to_string(), page: Some(8),
                location_status: "page_only".to_string(),
                ..Default::default()
            }),
        }]).await.unwrap();

        let files = repo.list_conversation_files(tenant_id, conversation_id, &[kb_id]).await.unwrap();
        assert_eq!(files.len(), 1);

        let cited = &files[0];
        assert_eq!(cited.doc_id, cited_doc_id);
        assert_eq!(cited.retrieval_count, 0);
        assert_eq!(cited.citation_count, 1);
        assert_eq!(cited.doc_title, "采购合同.pdf");
        assert_eq!(cited.preview_page_range, vec![8]);
        assert_eq!(cited.preview_quote, "验收后支付尾款");
    }
}
