UPDATE tenant_member
SET roles = ARRAY['tenant_admin'], updated_at = NOW()
WHERE roles = ARRAY['enterprise_admin'];

UPDATE tenant_member
SET roles = ARRAY['end_user'], updated_at = NOW()
WHERE roles = ARRAY['user'];

DELETE FROM knowledge_base_acl
WHERE subject_type = 'role'
  AND subject_id IN ('enterprise_admin', 'user');
