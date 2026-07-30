use uuid::Uuid;

use crate::models::citation::{Citation, CitationAnchor};
use crate::models::conversation::ConversationSession;
use crate::models::message::ConversationMessage;
use crate::models::trace::{RetrievalSource, RetrievalTrace};
use crate::models::{now, ConversationStatus, MessageRole, MessageStatus};

use super::super::memory::InMemoryConversationRepository;
use super::super::trait_repo::{ConversationFileRepository, ConversationRepository};

fn message(
    id: Uuid,
    conversation_id: Uuid,
    tenant_id: Uuid,
    user_id: Uuid,
    role: MessageRole,
) -> ConversationMessage {
    ConversationMessage {
        id,
        conversation_id,
        tenant_id,
        user_id,
        role,
        content: "测试消息".to_string(),
        status: MessageStatus::Completed,
        parent_message_id: None,
        retry_of_message_id: None,
        client_request_id: None,
        confidence: None,
        no_answer_reason: None,
        error_code: None,
        error_message: None,
        agent_mode: None,
        prompt_versions: None,
        created_at: now(),
        completed_at: Some(now()),
    }
}

#[tokio::test]
async fn deduplicates_retrievals_and_prefers_citation_preview() {
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
        id: conversation_id,
        tenant_id,
        user_id,
        title: "文件聚合测试".to_string(),
        kb_ids: vec![kb_id],
        status: ConversationStatus::Active,
        summary: None,
        created_at,
        updated_at: created_at,
    })
    .await
    .unwrap();
    repo.create_message(message(
        user_message_id,
        conversation_id,
        tenant_id,
        user_id,
        MessageRole::User,
    ))
    .await
    .unwrap();
    repo.create_message(message(
        assistant_message_id,
        conversation_id,
        tenant_id,
        user_id,
        MessageRole::Assistant,
    ))
    .await
    .unwrap();

    repo.save_retrieval_traces(vec![
        retrieval(user_message_id, cited_doc_id, 1, "检索片段"),
        retrieval(user_message_id, cited_doc_id, 2, "重排片段"),
        retrieval(user_message_id, retrieved_doc_id, 3, "另一份相关文件"),
    ])
    .await
    .unwrap();
    repo.save_citations(vec![Citation {
        id: Uuid::new_v4(),
        assistant_message_id,
        index: 1,
        chunk_id: Uuid::new_v4(),
        doc_id: cited_doc_id,
        doc_title: "采购合同.pdf".to_string(),
        page_range: vec![8],
        heading_path: vec![],
        quote: "验收后支付尾款".to_string(),
        score: 0.95,
        source_status: "available".to_string(),
        anchor: Some(CitationAnchor {
            format: "pdf".to_string(),
            page: Some(8),
            location_status: "page_only".to_string(),
            ..Default::default()
        }),
    }])
    .await
    .unwrap();

    let files = repo
        .list_conversation_files(tenant_id, conversation_id, &[kb_id])
        .await
        .unwrap();
    assert_eq!(files.len(), 2);

    let cited = files
        .iter()
        .find(|file| file.doc_id == cited_doc_id)
        .unwrap();
    assert_eq!(cited.retrieval_count, 1);
    assert_eq!(cited.citation_count, 1);
    assert_eq!(cited.doc_title, "采购合同.pdf");
    assert_eq!(cited.preview_page_range, vec![8]);
    assert_eq!(cited.preview_quote, "验收后支付尾款");

    let retrieved = files
        .iter()
        .find(|file| file.doc_id == retrieved_doc_id)
        .unwrap();
    assert_eq!(retrieved.retrieval_count, 1);
    assert_eq!(retrieved.citation_count, 0);
    assert_eq!(retrieved.preview_page_range, vec![3]);
}

fn retrieval(message_id: Uuid, doc_id: Uuid, page: i32, content_preview: &str) -> RetrievalTrace {
    RetrievalTrace {
        id: Uuid::new_v4(),
        message_id,
        chunk_id: Uuid::new_v4(),
        doc_id,
        source: RetrievalSource::Rerank,
        rank: page,
        score: 0.9,
        heading_path: vec![],
        page_range: vec![page],
        content_preview: content_preview.to_string(),
    }
}
