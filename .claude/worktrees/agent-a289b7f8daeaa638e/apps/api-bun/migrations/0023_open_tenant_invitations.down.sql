DELETE FROM tenant_invitation WHERE email IS NULL;
DROP INDEX IF EXISTS idx_tenant_invitation_pending_open;
ALTER TABLE tenant_invitation ALTER COLUMN email SET NOT NULL;
