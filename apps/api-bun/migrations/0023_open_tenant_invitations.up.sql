ALTER TABLE tenant_invitation ALTER COLUMN email DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitation_pending_open
ON tenant_invitation (tenant_id)
WHERE status = 'pending' AND email IS NULL;
