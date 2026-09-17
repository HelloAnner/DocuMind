CREATE TABLE IF NOT EXISTS tenant_invitation (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    email VARCHAR(128) NOT NULL,
    name VARCHAR(128),
    roles TEXT[] NOT NULL,
    kb_grants JSONB NOT NULL DEFAULT '[]',
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    invited_by UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    accepted_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitation_pending_email
ON tenant_invitation (tenant_id, lower(email))
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_tenant_invitation_tenant_status
ON tenant_invitation (tenant_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_tenant_id_pair
ON knowledge_base (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_tenant_kb_id_pair
ON documents (tenant_id, kb_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_tenant_kb_doc_id_pair
ON chunks (tenant_id, kb_id, doc_id, id);
