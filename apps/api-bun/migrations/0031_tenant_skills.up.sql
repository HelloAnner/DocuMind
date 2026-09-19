CREATE TABLE IF NOT EXISTS skill (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  content_sha256 VARCHAR(64) NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  source VARCHAR(16) NOT NULL CHECK (source IN ('editor','upload','import','conversation')),
  source_url TEXT,
  created_by UUID NOT NULL REFERENCES app_user(id),
  updated_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS skill_file (
  id UUID PRIMARY KEY,
  skill_id UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  path VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (skill_id, path)
);

CREATE INDEX IF NOT EXISTS ix_skill_tenant_updated ON skill(tenant_id, updated_at DESC);
