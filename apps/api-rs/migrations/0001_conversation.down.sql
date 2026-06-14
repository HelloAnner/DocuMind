DROP INDEX IF EXISTS idx_conversation_retrieval_traces_message;
DROP INDEX IF EXISTS idx_conversation_query_traces_message;
DROP INDEX IF EXISTS idx_conversation_feedback_message;
DROP INDEX IF EXISTS idx_conversation_citations_message;
DROP INDEX IF EXISTS idx_conversation_messages_session;
DROP INDEX IF EXISTS idx_conversation_sessions_user;
DROP INDEX IF EXISTS idx_conversation_messages_client_request;

DROP TABLE IF EXISTS conversation_feedback;
DROP TABLE IF EXISTS conversation_agent_traces;
DROP TABLE IF EXISTS conversation_citations;
DROP TABLE IF EXISTS conversation_retrieval_traces;
DROP TABLE IF EXISTS conversation_query_traces;
DROP TABLE IF EXISTS conversation_messages;
DROP TABLE IF EXISTS conversation_sessions;
