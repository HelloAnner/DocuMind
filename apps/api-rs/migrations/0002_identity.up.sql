CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE app_user (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         VARCHAR(128) UNIQUE NOT NULL,
    name          VARCHAR(128),
    avatar_url    TEXT,
    password_hash VARCHAR(256),
    auth_provider VARCHAR(32) NOT NULL DEFAULT 'email',
    sso_subject   VARCHAR(256),
    last_active_tenant UUID,
    status        VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenant (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(128) NOT NULL,
    slug       VARCHAR(64) UNIQUE NOT NULL,
    domain     VARCHAR(128),
    plan       VARCHAR(32) NOT NULL DEFAULT 'enterprise',
    status     VARCHAR(16) NOT NULL DEFAULT 'active',
    settings   JSONB NOT NULL DEFAULT '{}',
    branding   JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenant_member (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    roles       TEXT[] NOT NULL DEFAULT '{}',
    attributes  JSONB NOT NULL DEFAULT '{}',
    status      VARCHAR(16) NOT NULL DEFAULT 'active',
    invited_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    invited_at  TIMESTAMPTZ,
    joined_at   TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    UNIQUE (tenant_id, user_id)
);

CREATE TABLE knowledge_base (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    name         VARCHAR(128) NOT NULL,
    description  TEXT,
    status       VARCHAR(16) NOT NULL DEFAULT 'active',
    tags         TEXT[] NOT NULL DEFAULT '{}',
    chunking_settings JSONB NOT NULL DEFAULT '{}',
    retrieval_settings JSONB NOT NULL DEFAULT '{}',
    embedding_settings JSONB NOT NULL DEFAULT '{}',
    created_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE knowledge_base_acl (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL,
    kb_id        UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    subject_type VARCHAR(16) NOT NULL CHECK (subject_type IN ('user', 'role', 'group')),
    subject_id   VARCHAR(128) NOT NULL,
    permission   VARCHAR(16) NOT NULL CHECK (permission IN ('read', 'write', 'manage')),
    created_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, kb_id, subject_type, subject_id, permission)
);

CREATE TABLE audit_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID,
    actor_user_id UUID,
    actor_role    VARCHAR(64),
    action        VARCHAR(128) NOT NULL,
    resource_type VARCHAR(64),
    resource_id   VARCHAR(128),
    ip            VARCHAR(64),
    user_agent    TEXT,
    detail        JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenant_member_user ON tenant_member(user_id);
CREATE INDEX idx_tenant_member_tenant ON tenant_member(tenant_id);
CREATE INDEX idx_kb_tenant ON knowledge_base(tenant_id);
CREATE INDEX idx_kb_acl_kb ON knowledge_base_acl(kb_id);
CREATE INDEX idx_kb_acl_subject ON knowledge_base_acl(tenant_id, subject_type, subject_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);

-- Dev seed data
INSERT INTO tenant (id, name, slug, plan, status)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'Acme Corp', 'acme', 'enterprise', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_user (id, email, name, status)
VALUES
    ('00000000-0000-0000-0000-000000000002'::uuid, 'dev@documind.local', 'Dev Tenant Admin', 'active'),
    ('00000000-0000-0000-0000-000000000003'::uuid, 'Anner', 'Anner', 'active'),
    ('00000000-0000-0000-0000-000000000004'::uuid, 'user@documind.local', 'End User', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_member (tenant_id, user_id, roles, status, joined_at)
VALUES
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid, ARRAY['tenant_admin'], 'active', NOW()),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000003'::uuid, ARRAY['super_admin'], 'active', NOW()),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000004'::uuid, ARRAY['end_user'], 'active', NOW())
ON CONFLICT (tenant_id, user_id) DO NOTHING;

INSERT INTO knowledge_base (id, tenant_id, name, description, status, tags)
VALUES
    ('00000000-0000-0000-0000-000000000010'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, '产品文档库', '面向全公司的产品手册与白皮书集合', 'active', ARRAY['产品']),
    ('00000000-0000-0000-0000-000000000011'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, '销售资料库', '销售策略、报价单与合同模板', 'active', ARRAY['销售']),
    ('00000000-0000-0000-0000-000000000012'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, '人力资源库', '员工手册、报销政策与规章制度', 'active', ARRAY['人事'])
ON CONFLICT (id) DO NOTHING;

-- tenant_admin & super_admin have manage on all KBs; end_user has read on product & sales only.
INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission)
VALUES
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000010'::uuid, 'role', 'tenant_admin', 'manage'),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000011'::uuid, 'role', 'tenant_admin', 'manage'),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000012'::uuid, 'role', 'tenant_admin', 'manage'),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000010'::uuid, 'role', 'super_admin', 'manage'),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000011'::uuid, 'role', 'super_admin', 'manage'),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000012'::uuid, 'role', 'super_admin', 'manage'),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000010'::uuid, 'role', 'end_user', 'read'),
    ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000011'::uuid, 'role', 'end_user', 'read')
ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING;
