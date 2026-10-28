ALTER TABLE conversation_sessions
    ADD COLUMN IF NOT EXISTS title_locked BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE conversation_sessions
SET title_locked = TRUE
WHERE BTRIM(title) <> '新会话';
