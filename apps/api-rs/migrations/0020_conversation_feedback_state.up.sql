WITH ranked_feedback AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY assistant_message_id, user_id
            ORDER BY created_at DESC, id DESC
        ) AS row_number
    FROM conversation_feedback
)
DELETE FROM conversation_feedback feedback
USING ranked_feedback ranked
WHERE feedback.id = ranked.id
  AND ranked.row_number > 1;

ALTER TABLE conversation_feedback
    ADD COLUMN updated_at TIMESTAMPTZ;

UPDATE conversation_feedback
SET updated_at = created_at;

ALTER TABLE conversation_feedback
    ALTER COLUMN updated_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET NOT NULL;

CREATE UNIQUE INDEX idx_conversation_feedback_message_user
    ON conversation_feedback (assistant_message_id, user_id);
