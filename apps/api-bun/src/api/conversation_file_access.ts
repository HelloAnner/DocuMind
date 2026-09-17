// 移植自 apps/api-rs/src/api/conversation_file_access.rs
import type { Sql } from 'postgres';
import type { CurrentActor } from '../models/identity.ts';

export async function isConversationFileAccessible(
  sql: Sql, actor: CurrentActor, conversationId: string, docId: string, kbId: string,
): Promise<boolean> {
  if (!actor.allowed_kb_ids.includes(kbId)) return false;
  const rows = await sql`
    SELECT EXISTS (
        SELECT 1
        FROM conversation_sessions session
        WHERE session.id = ${conversationId}
          AND session.tenant_id = ${actor.tenant_id}
          AND session.user_id = ${actor.user_id}
          AND session.status = 'active'
          AND (
              cardinality(session.kb_ids) = 0
              OR ${kbId} = ANY(session.kb_ids)
          )
          AND (
              EXISTS (
                  SELECT 1
                  FROM conversation_messages message
                  JOIN conversation_retrieval_traces trace
                    ON trace.message_id = message.id
                  WHERE message.conversation_id = session.id
                    AND message.tenant_id = session.tenant_id
                    AND trace.doc_id = ${docId}
              )
              OR EXISTS (
                  SELECT 1
                  FROM conversation_messages message
                  JOIN conversation_citations citation
                    ON citation.assistant_message_id = message.id
                  WHERE message.conversation_id = session.id
                    AND message.tenant_id = session.tenant_id
                    AND citation.doc_id = ${docId}
              )
          )
    ) AS accessible
  `;
  return Boolean(rows[0]?.accessible);
}
