CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_email_lower
ON app_user (lower(email));

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_status_check') THEN
        ALTER TABLE app_user
        ADD CONSTRAINT app_user_status_check
        CHECK (status IN ('active', 'suspended'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_last_active_tenant_fkey') THEN
        ALTER TABLE app_user
        ADD CONSTRAINT app_user_last_active_tenant_fkey
        FOREIGN KEY (last_active_tenant) REFERENCES tenant(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_member_status_check') THEN
        ALTER TABLE tenant_member
        ADD CONSTRAINT tenant_member_status_check
        CHECK (status IN ('active', 'suspended', 'removed'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_member_roles_check') THEN
        ALTER TABLE tenant_member
        ADD CONSTRAINT tenant_member_roles_check
        CHECK (
            cardinality(roles) >= 1
            AND roles <@ ARRAY['super_admin', 'tenant_admin', 'end_user']::text[]
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_invitation_roles_check') THEN
        ALTER TABLE tenant_invitation
        ADD CONSTRAINT tenant_invitation_roles_check
        CHECK (
            cardinality(roles) >= 1
            AND roles <@ ARRAY['tenant_admin', 'end_user']::text[]
        );
    END IF;
END $$;
