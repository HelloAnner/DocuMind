ALTER TABLE app_user ADD COLUMN IF NOT EXISTS login_id VARCHAR(128);
UPDATE app_user SET login_id = email WHERE login_id IS NULL OR btrim(login_id) = '';
ALTER TABLE app_user ALTER COLUMN login_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_login_id_lower ON app_user (lower(login_id));
ALTER TABLE app_user ALTER COLUMN email DROP NOT NULL;
