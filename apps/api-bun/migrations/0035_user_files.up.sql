ALTER TABLE conversation_sessions
  ADD CONSTRAINT uq_conversation_sessions_owner UNIQUE (id, tenant_id, user_id);
ALTER TABLE conversation_messages
  ADD CONSTRAINT uq_conversation_messages_owner UNIQUE (id, tenant_id, user_id);

CREATE TABLE user_file (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  conversation_id UUID,
  name VARCHAR(255) NOT NULL,
  path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  source VARCHAR(16) NOT NULL CHECK (source IN ('upload', 'sandbox')),
  storage_key TEXT NOT NULL UNIQUE,
  extracted_text TEXT,
  extraction_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, tenant_id, user_id),
  UNIQUE (tenant_id, user_id, path),
  FOREIGN KEY (conversation_id, tenant_id, user_id)
    REFERENCES conversation_sessions(id, tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE user_file_object_cleanup (
  id BIGSERIAL PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  reservation_token UUID,
  claim_token UUID,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION enqueue_user_file_object_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO user_file_object_cleanup(storage_key)
  VALUES (OLD.storage_key)
  ON CONFLICT (storage_key) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_user_file_object_cleanup
AFTER DELETE ON user_file
FOR EACH ROW EXECUTE FUNCTION enqueue_user_file_object_cleanup();

CREATE TABLE conversation_message_file (
  message_id UUID NOT NULL,
  file_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, file_id),
  FOREIGN KEY (message_id, tenant_id, user_id)
    REFERENCES conversation_messages(id, tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (file_id, tenant_id, user_id)
    REFERENCES user_file(id, tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX ix_user_file_owner_updated
  ON user_file(tenant_id, user_id, updated_at DESC);
CREATE INDEX ix_user_file_conversation_updated
  ON user_file(tenant_id, user_id, conversation_id, updated_at DESC);
CREATE INDEX ix_conversation_message_file_file
  ON conversation_message_file(file_id);
CREATE INDEX ix_user_file_object_cleanup_available
  ON user_file_object_cleanup(available_at, id);
