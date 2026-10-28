ALTER TABLE tenant_invitation ADD COLUMN IF NOT EXISTS kind VARCHAR(24) NOT NULL DEFAULT 'targeted';
ALTER TABLE tenant_invitation ADD COLUMN IF NOT EXISTS invitee_username_normalized VARCHAR(128);

UPDATE tenant_invitation
SET invitee_username_normalized = lower(trim(email))
WHERE email IS NOT NULL AND invitee_username_normalized IS NULL;

UPDATE tenant_invitation
SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW()
WHERE status = 'pending';
ALTER TABLE tenant_invitation DROP CONSTRAINT IF EXISTS tenant_invitation_roles_check;


UPDATE tenant_invitation
SET kind = 'bootstrap_owner', roles = ARRAY['tenant_owner']
WHERE email IS NULL;

DROP INDEX IF EXISTS idx_tenant_invitation_pending_email;
DROP INDEX IF EXISTS idx_tenant_invitation_pending_open;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitation_pending_target
ON tenant_invitation (tenant_id, invitee_username_normalized)
WHERE status = 'pending' AND kind = 'targeted';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitation_pending_bootstrap
ON tenant_invitation (tenant_id)
WHERE status = 'pending' AND kind = 'bootstrap_owner';
ALTER TABLE tenant_invitation
ADD CONSTRAINT tenant_invitation_roles_check CHECK (
  cardinality(roles) >= 1
  AND roles <@ ARRAY['tenant_owner', 'tenant_admin', 'end_user']::text[]
  AND (
    (kind = 'bootstrap_owner' AND roles = ARRAY['tenant_owner']::text[])
    OR (kind = 'targeted' AND NOT ('tenant_owner' = ANY(roles)))
  )
);


ALTER TABLE tenant_invitation DROP COLUMN IF EXISTS email;
ALTER TABLE tenant_invitation DROP COLUMN IF EXISTS name;

ALTER TABLE tenant_invitation DROP CONSTRAINT IF EXISTS tenant_invitation_kind_check;
ALTER TABLE tenant_invitation
ADD CONSTRAINT tenant_invitation_kind_check CHECK (
  (kind = 'targeted' AND invitee_username_normalized IS NOT NULL)
  OR (kind = 'bootstrap_owner' AND invitee_username_normalized IS NULL)
);
