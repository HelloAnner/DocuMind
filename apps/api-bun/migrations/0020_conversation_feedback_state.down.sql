DROP INDEX IF EXISTS idx_conversation_feedback_message_user;

ALTER TABLE conversation_feedback
    DROP COLUMN IF EXISTS updated_at;
