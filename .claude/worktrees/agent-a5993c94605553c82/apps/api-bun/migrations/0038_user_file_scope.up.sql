-- 文件管理：区分「个人文件」与「空间文件」。
--
-- personal：仅上传者本人可见，保持原有行为。
-- space   ：当前企业空间（tenant）内全体成员可见，user_id 记录上传者。
--
-- 关键是唯一约束必须按 scope 拆开：原来的 UNIQUE(tenant_id, user_id, path) 对空间文件
-- 是错的——空间文件全租户共享，按上传者算路径唯一性会让两个人传同名文件时互相看不见。
ALTER TABLE user_file ADD COLUMN IF NOT EXISTS scope VARCHAR(16) NOT NULL DEFAULT 'personal';
ALTER TABLE user_file DROP CONSTRAINT IF EXISTS ck_user_file_scope;
ALTER TABLE user_file
  ADD CONSTRAINT ck_user_file_scope CHECK (scope IN ('personal', 'space')) NOT VALID;
ALTER TABLE user_file VALIDATE CONSTRAINT ck_user_file_scope;

ALTER TABLE user_file DROP CONSTRAINT IF EXISTS user_file_tenant_id_user_id_path_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_file_personal_path
  ON user_file(tenant_id, user_id, path) WHERE scope = 'personal';
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_file_space_path
  ON user_file(tenant_id, path) WHERE scope = 'space';
CREATE INDEX IF NOT EXISTS ix_user_file_space_updated
  ON user_file(tenant_id, updated_at DESC) WHERE scope = 'space';
