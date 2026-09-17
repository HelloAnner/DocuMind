ALTER TABLE chunk_embeddings DROP CONSTRAINT IF EXISTS fk_embeddings_tenant_chunk;
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS fk_chunks_tenant_document;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS fk_documents_tenant_kb;
ALTER TABLE knowledge_base_acl DROP CONSTRAINT IF EXISTS fk_acl_tenant_kb;
ALTER TABLE tenant DROP CONSTRAINT IF EXISTS tenant_status_lifecycle_check;

DROP INDEX IF EXISTS idx_tenant_lifecycle_status;
DROP INDEX IF EXISTS idx_platform_admin_status;
DROP INDEX IF EXISTS idx_source_anchors_tenant_doc_id_pair;

ALTER TABLE tenant
    DROP COLUMN IF EXISTS deletion_requested_by,
    DROP COLUMN IF EXISTS deletion_requested_at,
    DROP COLUMN IF EXISTS archived_at,
    DROP COLUMN IF EXISTS suspended_at;

DROP TABLE IF EXISTS platform_admin;
