CREATE TABLE IF NOT EXISTS platform_admin (
    user_id UUID PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL DEFAULT 'super_admin' CHECK (role = 'super_admin'),
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_admin (user_id, role, status)
SELECT DISTINCT tm.user_id, 'super_admin', 'active'
FROM tenant_member tm
WHERE 'super_admin' = ANY(tm.roles)
ON CONFLICT (user_id) DO UPDATE
SET role = 'super_admin', status = 'active', updated_at = NOW();

ALTER TABLE tenant
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_requested_by UUID REFERENCES app_user(id) ON DELETE SET NULL;

UPDATE tenant
SET status = 'active'
WHERE status NOT IN ('pending', 'active', 'suspended', 'archived', 'deletion_pending');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tenant_status_lifecycle_check'
    ) THEN
        ALTER TABLE tenant
        ADD CONSTRAINT tenant_status_lifecycle_check
        CHECK (status IN ('pending', 'active', 'suspended', 'archived', 'deletion_pending'));
    END IF;
END $$;

UPDATE tenant_member tm
SET roles = ARRAY(
        SELECT DISTINCT CASE
            WHEN role IN ('enterprise_admin', 'team_admin', 'data_admin', 'tenant_owner', 'tenant_admin')
                THEN 'tenant_admin'
            WHEN role IN ('user', 'analyst', 'end_user', 'viewer')
                THEN 'end_user'
            WHEN role = 'super_admin'
                THEN 'super_admin'
            ELSE role
        END
        FROM unnest(tm.roles) AS role
    ),
    updated_at = NOW()
WHERE tm.roles && ARRAY[
    'enterprise_admin', 'team_admin', 'data_admin', 'tenant_owner',
    'tenant_admin', 'user', 'analyst', 'end_user', 'viewer'
];

UPDATE tenant_invitation inv
SET roles = ARRAY(
        SELECT DISTINCT CASE
            WHEN role IN ('enterprise_admin', 'team_admin', 'data_admin', 'tenant_owner', 'tenant_admin')
                THEN 'tenant_admin'
            WHEN role IN ('user', 'analyst', 'end_user', 'viewer')
                THEN 'end_user'
            ELSE role
        END
        FROM unnest(inv.roles) AS role
    ),
    updated_at = NOW()
WHERE inv.roles && ARRAY[
    'enterprise_admin', 'team_admin', 'data_admin', 'tenant_owner',
    'tenant_admin', 'user', 'analyst', 'end_user', 'viewer'
];

INSERT INTO knowledge_base_acl
    (tenant_id, kb_id, subject_type, subject_id, permission, created_by, created_at)
SELECT acl.tenant_id,
       acl.kb_id,
       'role',
       CASE
           WHEN acl.subject_id IN ('enterprise_admin', 'team_admin', 'data_admin', 'tenant_owner', 'tenant_admin')
               THEN 'tenant_admin'
           WHEN acl.subject_id IN ('user', 'analyst', 'end_user', 'viewer')
               THEN 'end_user'
           ELSE acl.subject_id
       END,
       acl.permission,
       acl.created_by,
       acl.created_at
FROM knowledge_base_acl acl
WHERE acl.subject_type = 'role'
  AND acl.subject_id IN (
      'enterprise_admin', 'team_admin', 'data_admin', 'tenant_owner',
      'tenant_admin', 'user', 'analyst', 'end_user', 'viewer'
  )
ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING;

DELETE FROM knowledge_base_acl
WHERE subject_type = 'role'
  AND subject_id IN (
      'super_admin', 'enterprise_admin', 'team_admin', 'data_admin',
      'tenant_owner', 'user', 'analyst', 'viewer'
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_anchors_tenant_doc_id_pair
ON document_source_anchors (tenant_id, doc_id, id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acl_tenant_kb') THEN
        ALTER TABLE knowledge_base_acl
        ADD CONSTRAINT fk_acl_tenant_kb
        FOREIGN KEY (tenant_id, kb_id)
        REFERENCES knowledge_base (tenant_id, id)
        ON DELETE CASCADE NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_tenant_kb') THEN
        ALTER TABLE documents
        ADD CONSTRAINT fk_documents_tenant_kb
        FOREIGN KEY (tenant_id, kb_id)
        REFERENCES knowledge_base (tenant_id, id)
        ON DELETE CASCADE NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_chunks_tenant_document') THEN
        ALTER TABLE chunks
        ADD CONSTRAINT fk_chunks_tenant_document
        FOREIGN KEY (tenant_id, kb_id, doc_id)
        REFERENCES documents (tenant_id, kb_id, id)
        ON DELETE CASCADE NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_embeddings_tenant_chunk') THEN
        ALTER TABLE chunk_embeddings
        ADD CONSTRAINT fk_embeddings_tenant_chunk
        FOREIGN KEY (tenant_id, kb_id, doc_id, chunk_id)
        REFERENCES chunks (tenant_id, kb_id, doc_id, id)
        ON DELETE CASCADE NOT VALID;
    END IF;
END $$;

ALTER TABLE knowledge_base_acl VALIDATE CONSTRAINT fk_acl_tenant_kb;
ALTER TABLE documents VALIDATE CONSTRAINT fk_documents_tenant_kb;
ALTER TABLE chunks VALIDATE CONSTRAINT fk_chunks_tenant_document;
ALTER TABLE chunk_embeddings VALIDATE CONSTRAINT fk_embeddings_tenant_chunk;

CREATE INDEX IF NOT EXISTS idx_platform_admin_status
ON platform_admin (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_lifecycle_status
ON tenant (status, updated_at DESC);
