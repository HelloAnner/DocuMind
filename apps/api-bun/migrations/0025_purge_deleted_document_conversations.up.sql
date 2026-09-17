WITH stale_sessions AS (
    SELECT DISTINCT message.conversation_id
    FROM conversation_messages message
    JOIN conversation_citations citation ON citation.assistant_message_id = message.id
    LEFT JOIN documents document ON document.id = citation.doc_id
    WHERE document.id IS NULL

    UNION

    SELECT DISTINCT message.conversation_id
    FROM conversation_messages message
    JOIN conversation_retrieval_traces trace ON trace.message_id = message.id
    LEFT JOIN documents document ON document.id = trace.doc_id
    WHERE document.id IS NULL
)
DELETE FROM conversation_sessions session
USING stale_sessions stale
WHERE session.id = stale.conversation_id;
