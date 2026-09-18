CREATE TABLE tenant_creation_request (
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(128) NOT NULL,
    tenant_id       UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, idempotency_key)
);
