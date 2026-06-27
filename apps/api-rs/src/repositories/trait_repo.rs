use async_trait::async_trait;
use uuid::Uuid;

use crate::models::agent::{AgentTrace, CitationOutput};
use crate::models::citation::Citation;
use crate::models::conversation::{ConversationListResponse, ConversationSession};
use crate::models::feedback::Feedback;
use crate::models::message::ConversationMessage;
use crate::models::trace::{QueryTrace, RetrievalTrace};

#[async_trait]
pub trait ConversationRepository: Send + Sync {
    async fn create_session(&self, session: ConversationSession) -> anyhow::Result<()>;
    async fn list_sessions(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        limit: usize,
        cursor: Option<String>,
    ) -> anyhow::Result<ConversationListResponse>;
    async fn get_session(
        &self,
        tenant_id: Uuid,
        conversation_id: Uuid,
    ) -> anyhow::Result<Option<ConversationSession>>;
    async fn update_session(&self, session: ConversationSession) -> anyhow::Result<()>;

    async fn create_message(&self, message: ConversationMessage) -> anyhow::Result<()>;
    async fn get_message(
        &self,
        tenant_id: Uuid,
        message_id: Uuid,
    ) -> anyhow::Result<Option<ConversationMessage>>;
    async fn get_messages(
        &self,
        tenant_id: Uuid,
        conversation_id: Uuid,
    ) -> anyhow::Result<Vec<ConversationMessage>>;
    async fn update_message(&self, message: ConversationMessage) -> anyhow::Result<()>;
    async fn find_message_by_client_request_id(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        client_request_id: &str,
    ) -> anyhow::Result<Option<ConversationMessage>>;

    async fn save_query_trace(&self, trace: QueryTrace) -> anyhow::Result<()>;
    async fn get_query_trace(&self, message_id: Uuid) -> anyhow::Result<Option<QueryTrace>>;

    async fn save_retrieval_traces(&self, traces: Vec<RetrievalTrace>) -> anyhow::Result<()>;
    async fn get_retrieval_traces(&self, message_id: Uuid) -> anyhow::Result<Vec<RetrievalTrace>>;

    async fn save_citations(&self, citations: Vec<Citation>) -> anyhow::Result<()>;
    async fn get_citations(&self, assistant_message_id: Uuid) -> anyhow::Result<Vec<Citation>>;

    async fn save_agent_trace(
        &self,
        assistant_message_id: Uuid,
        trace: AgentTrace,
    ) -> anyhow::Result<()>;
    async fn get_agent_trace(
        &self,
        assistant_message_id: Uuid,
    ) -> anyhow::Result<Option<AgentTrace>>;

    async fn doc_version_hash(&self, tenant_id: Uuid, kb_ids: &[Uuid]) -> anyhow::Result<String>;
    async fn citations_valid_for_scope(
        &self,
        tenant_id: Uuid,
        kb_ids: &[Uuid],
        citations: &[CitationOutput],
    ) -> anyhow::Result<bool>;

    async fn save_feedback(&self, feedback: Feedback) -> anyhow::Result<()>;
}
