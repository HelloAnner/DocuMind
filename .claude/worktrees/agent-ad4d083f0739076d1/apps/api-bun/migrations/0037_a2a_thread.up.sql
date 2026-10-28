-- A2A: Portal contextId -> DocuMind 本地会话映射（同一 contextId 复用同一条会话）
CREATE TABLE a2a_thread (
    portal_context_id VARCHAR(200) PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_a2a_thread_conversation ON a2a_thread(conversation_id);
CREATE INDEX idx_a2a_thread_owner ON a2a_thread(tenant_id, user_id);
