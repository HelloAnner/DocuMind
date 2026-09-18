UPDATE tenant_member
SET roles = array_replace(roles, 'tenant_owner', 'tenant_admin')
WHERE 'tenant_owner' = ANY(roles);
ALTER TABLE tenant_member DROP CONSTRAINT IF EXISTS tenant_member_roles_check;
ALTER TABLE tenant_member
ADD CONSTRAINT tenant_member_roles_check
CHECK (
    cardinality(roles) >= 1
    AND roles <@ ARRAY['super_admin', 'tenant_admin', 'end_user']::text[]
);
