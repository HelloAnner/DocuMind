UPDATE app_user SET email = login_id WHERE email IS NULL;
ALTER TABLE app_user ALTER COLUMN email SET NOT NULL;
DROP INDEX IF EXISTS idx_app_user_login_id_lower;
ALTER TABLE app_user DROP COLUMN IF EXISTS login_id;
