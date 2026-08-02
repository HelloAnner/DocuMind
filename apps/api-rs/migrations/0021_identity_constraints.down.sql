ALTER TABLE tenant_invitation DROP CONSTRAINT IF EXISTS tenant_invitation_roles_check;
ALTER TABLE tenant_member DROP CONSTRAINT IF EXISTS tenant_member_roles_check;
ALTER TABLE tenant_member DROP CONSTRAINT IF EXISTS tenant_member_status_check;
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_last_active_tenant_fkey;
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_status_check;
DROP INDEX IF EXISTS idx_app_user_email_lower;
