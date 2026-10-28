ALTER TABLE tenant_member DROP CONSTRAINT IF EXISTS tenant_member_roles_check;
ALTER TABLE tenant_member
ADD CONSTRAINT tenant_member_roles_check
CHECK (
    cardinality(roles) >= 1
    AND roles <@ ARRAY['super_admin', 'tenant_owner', 'tenant_admin', 'end_user']::text[]
);
