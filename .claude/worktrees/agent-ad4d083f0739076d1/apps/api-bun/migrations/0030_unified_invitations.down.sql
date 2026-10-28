ALTER TABLE tenant_invitation DROP CONSTRAINT IF EXISTS tenant_invitation_roles_check;
ALTER TABLE tenant_invitation DROP CONSTRAINT IF EXISTS tenant_invitation_kind_check;
UPDATE tenant_invitation SET roles = ARRAY['tenant_admin'] WHERE kind = 'bootstrap_owner';
DROP INDEX IF EXISTS idx_tenant_invitation_pending_target;
DROP INDEX IF EXISTS idx_tenant_invitation_pending_bootstrap;
ALTER TABLE tenant_invitation ADD COLUMN IF NOT EXISTS email VARCHAR(128);
ALTER TABLE tenant_invitation ADD COLUMN IF NOT EXISTS name VARCHAR(128);
UPDATE tenant_invitation SET email = invitee_username_normalized WHERE kind = 'targeted';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitation_pending_email
ON tenant_invitation (tenant_id, lower(email)) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitation_pending_open
ON tenant_invitation (tenant_id) WHERE status = 'pending' AND email IS NULL;
ALTER TABLE tenant_invitation
ADD CONSTRAINT tenant_invitation_roles_check CHECK (
  cardinality(roles) >= 1
  AND roles <@ ARRAY['tenant_admin', 'end_user']::text[]
);
ALTER TABLE tenant_invitation DROP COLUMN IF EXISTS invitee_username_normalized;
ALTER TABLE tenant_invitation DROP COLUMN IF EXISTS kind;
