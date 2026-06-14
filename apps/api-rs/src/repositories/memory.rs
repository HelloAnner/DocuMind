use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use uuid::Uuid;

use crate::models::agent::AgentTrace;
use crate::models::citation::Citation;
use crate::models::conversation::{ConversationListItem, ConversationListResponse, ConversationSession};
use crate::models::ConversationStatus;
use crate::models::feedback::Feedback;
use crate::models::message::ConversationMessage;
use crate::models::trace::{QueryTrace, RetrievalTrace};

use super::trait_repo::ConversationRepository;

pub struct InMemoryConversationRepository {
    sessions: Arc<RwLock<HashMap<Uuid, ConversationSession>>>,
    messages: Arc<RwLock<HashMap<Uuid, ConversationMessage>>>,
    client_request_ids: Arc<RwLock<HashMap<(Uuid, Uuid, String), Uuid>>>,
    query_traces: Arc<RwLock<HashMap<Uuid, QueryTrace>>>,
    retrieval_traces: Arc<RwLock<HashMap<Uuid, Vec<RetrievalTrace>>>>,
    citations: Arc<RwLock<HashMap<Uuid, Vec<Citation>>>>,
    agent_traces: Arc<RwLock<HashMap<Uuid, AgentTrace>>>,
    feedback: Arc<RwLock<HashMap<Uuid, Feedback>>>,
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
        let offset = cursor
            .and_then(|c| c.parse::<usize>().ok())
            .unwrap_or(0);

        let mut list: Vec<&ConversationSession> = sessions
            .values()
            .filter(|s| s.tenant_id == tenant_id && s.user_id == user_id && s.status == ConversationStatus::Active)
            .collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        let _total = list.len();
        let page: Vec<ConversationListItem> = list
            .into_iter()
            .skip(offset)
            .take(limit + 1)
            .map(|s| {
                let preview = self.messages.read().unwrap().values()
                    .filter(|m| m.conversation_id == s.id && m.role == crate::models::MessageRole::User && m.status == crate::models::MessageStatus::Completed)
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
        Ok(sessions.get(&conversation_id).filter(|s| s.tenant_id == tenant_id).cloned())
    }

    async fn update_session(&self, session: ConversationSession) -> anyhow::Result<()> {
        let mut sessions = self.sessions.write().unwrap();
        sessions.insert(session.id, session);
        Ok(())
    }

    async fn create_message(&self, message: ConversationMessage) -> anyhow::Result<()> {
        let mut messages = self.messages.write().unwrap();
        if let Some(ref req_id) = message.client_request_id {
            let mut cr = self.client_request_ids.write().unwrap();
            cr.insert((message.tenant_id, message.user_id, req_id.clone()), message.id);
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
        Ok(messages.get(&message_id).filter(|m| m.tenant_id == tenant_id).cloned())
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

    async fn save_agent_trace(&self, assistant_message_id: Uuid, trace: AgentTrace) -> anyhow::Result<()> {
        let mut at = self.agent_traces.write().unwrap();
        at.insert(assistant_message_id, trace);
        Ok(())
    }

    async fn get_agent_trace(&self, assistant_message_id: Uuid) -> anyhow::Result<Option<AgentTrace>> {
        let at = self.agent_traces.read().unwrap();
        Ok(at.get(&assistant_message_id).cloned())
    }

    async fn save_feedback(&self, feedback: Feedback) -> anyhow::Result<()> {
        let mut fb = self.feedback.write().unwrap();
        fb.insert(feedback.id, feedback);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::conversation::ConversationSession;
    use crate::models::message::ConversationMessage;
    use crate::models::now;
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
}
