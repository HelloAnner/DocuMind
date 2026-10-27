-- DocuMind 统一 RBAC：个人级权限覆盖。
-- 角色基线仍在 tenant_member.roles / knowledge_base_acl(role)。
-- subject_type 预留 user，后续加 role/group 不需要改主键。
CREATE TABLE IF NOT EXISTS permission_override (
    tenant_id    UUID NOT NULL,
    subject_type TEXT NOT NULL DEFAULT 'user' CHECK (subject_type IN ('user')),
    subject_id   UUID NOT NULL,
    entity_type  TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('view', 'edit', 'manage')),
    effect       TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    updated_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, subject_type, subject_id, entity_type, entity_id, action)
);

CREATE INDEX IF NOT EXISTS idx_permission_override_subject
    ON permission_override (tenant_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_permission_override_entity
    ON permission_override (tenant_id, entity_type, entity_id);

-- 把已有的个人知识库 ACL 迁移成 allow 覆盖；角色 ACL 继续作为基线。
INSERT INTO permission_override
    (tenant_id, subject_type, subject_id, entity_type, entity_id, action, effect, updated_by)
SELECT acl.tenant_id,
       'user',
       acl.subject_id::uuid,
       'kb',
       acl.kb_id::text,
       CASE acl.permission WHEN 'read' THEN 'view' WHEN 'write' THEN 'edit' ELSE 'manage' END,
       'allow',
       acl.created_by
FROM knowledge_base_acl acl
WHERE acl.subject_type = 'user'
  AND acl.subject_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (tenant_id, subject_type, subject_id, entity_type, entity_id, action) DO NOTHING;
