use sqlx::PgPool;
use uuid::Uuid;

use crate::models::CurrentActor;

pub async fn is_conversation_file_accessible(
    pool: &PgPool,
    actor: &CurrentActor,
    conversation_id: Uuid,
    doc_id: Uuid,
    kb_id: Uuid,
) -> Result<bool, sqlx::Error> {
    if !actor.allowed_kb_ids.contains(&kb_id) {
        return Ok(false);
    }

    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM conversation_sessions session
            WHERE session.id = $1
              AND session.tenant_id = $2
              AND session.user_id = $3
              AND session.status = 'active'
              AND (
                  cardinality(session.kb_ids) = 0
                  OR $5 = ANY(session.kb_ids)
              )
              AND (
                  EXISTS (
                      SELECT 1
                      FROM conversation_messages message
                      JOIN conversation_retrieval_traces trace
                        ON trace.message_id = message.id
                      WHERE message.conversation_id = session.id
                        AND message.tenant_id = session.tenant_id
                        AND trace.doc_id = $4
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM conversation_messages message
                      JOIN conversation_citations citation
                        ON citation.assistant_message_id = message.id
                      WHERE message.conversation_id = session.id
                        AND message.tenant_id = session.tenant_id
                        AND citation.doc_id = $4
                  )
              )
        )
        "#,
    )
    .bind(conversation_id)
    .bind(actor.tenant_id)
    .bind(actor.user_id)
    .bind(doc_id)
    .bind(kb_id)
    .fetch_one(pool)
    .await
}
