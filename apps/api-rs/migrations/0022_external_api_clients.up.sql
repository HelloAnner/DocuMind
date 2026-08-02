CREATE TABLE api_client (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    service_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    scopes TEXT[] NOT NULL DEFAULT ARRAY['knowledge_bases:read', 'chat:write', 'conversations:read'],
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
    created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, name),
    UNIQUE (service_user_id)
);

CREATE TABLE api_token (
    id UUID PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES api_client(id) ON DELETE CASCADE,
    token_prefix VARCHAR(64) NOT NULL,
    secret_hash VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    UNIQUE (secret_hash)
);

CREATE INDEX idx_api_client_tenant ON api_client(tenant_id, created_at DESC);
CREATE INDEX idx_api_token_client ON api_token(client_id, created_at DESC);
