CREATE TABLE portal_tenant_mapping (
    portal_tenant_id UUID PRIMARY KEY,
    portal_tenant_code VARCHAR(64) NOT NULL,
    tenant_id UUID NOT NULL UNIQUE REFERENCES tenant(id) ON DELETE CASCADE,
    origin VARCHAR(16) NOT NULL CHECK (origin IN ('approved', 'portal_created')),
    approved_by UUID REFERENCES app_user(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((origin = 'approved' AND approved_by IS NOT NULL)
        OR (origin = 'portal_created' AND approved_by IS NULL))
);

CREATE TABLE portal_identity_mapping (
    portal_user_id UUID NOT NULL,
    portal_tenant_id UUID NOT NULL REFERENCES portal_tenant_mapping(portal_tenant_id) ON DELETE CASCADE,
    local_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    local_tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    PRIMARY KEY (portal_user_id, portal_tenant_id),
    UNIQUE (portal_tenant_id, local_user_id)
);

-- Backfill only unambiguous tenant-matched identities. A global SSO account
-- used in multiple tenants must be linked separately using verified local sessions.
INSERT INTO portal_identity_mapping (portal_user_id, portal_tenant_id, local_user_id, local_tenant_id)
SELECT u.sso_subject::uuid, m.portal_tenant_id, u.id, m.tenant_id
FROM app_user u
JOIN tenant_member tm ON tm.user_id = u.id AND tm.status = 'active'
JOIN portal_tenant_mapping m ON m.tenant_id = tm.tenant_id
WHERE u.auth_provider = 'portal'
  AND u.sso_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND tm.attributes->>'portal_user_id' = u.sso_subject
  AND tm.attributes->>'portal_tenant_id' = m.portal_tenant_id::text
  AND NOT EXISTS (
    SELECT 1 FROM tenant_member other
    WHERE other.user_id = u.id AND other.status = 'active'
      AND other.tenant_id <> tm.tenant_id
      AND other.attributes->>'portal_user_id' = u.sso_subject
  );
