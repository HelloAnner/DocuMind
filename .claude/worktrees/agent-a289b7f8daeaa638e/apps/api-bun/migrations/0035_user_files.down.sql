DROP TABLE IF EXISTS conversation_message_file;
DROP TRIGGER IF EXISTS trg_user_file_object_cleanup ON user_file;
DROP TABLE IF EXISTS user_file;
DROP FUNCTION IF EXISTS enqueue_user_file_object_cleanup();
DROP TABLE IF EXISTS user_file_object_cleanup;
ALTER TABLE conversation_messages DROP CONSTRAINT IF EXISTS uq_conversation_messages_owner;
ALTER TABLE conversation_sessions DROP CONSTRAINT IF EXISTS uq_conversation_sessions_owner;
