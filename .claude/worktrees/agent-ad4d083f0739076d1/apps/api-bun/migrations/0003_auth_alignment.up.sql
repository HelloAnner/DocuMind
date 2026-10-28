-- Align DocuMind's seed identity model with the Northline-style role names
-- while keeping legacy role ACLs readable for existing data.

ALTER TABLE tenant_member
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE tenant_member
SET roles = ARRAY['enterprise_admin'], updated_at = NOW()
WHERE roles = ARRAY['tenant_admin'];

UPDATE tenant_member
SET roles = ARRAY['user'], updated_at = NOW()
WHERE roles = ARRAY['end_user'];

INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission)
SELECT tenant_id, kb_id, subject_type, 'enterprise_admin', permission
FROM knowledge_base_acl
WHERE subject_type = 'role' AND subject_id = 'tenant_admin'
ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING;

INSERT INTO knowledge_base_acl (tenant_id, kb_id, subject_type, subject_id, permission)
SELECT tenant_id, kb_id, subject_type, 'user', permission
FROM knowledge_base_acl
WHERE subject_type = 'role' AND subject_id = 'end_user'
ON CONFLICT (tenant_id, kb_id, subject_type, subject_id, permission) DO NOTHING;
