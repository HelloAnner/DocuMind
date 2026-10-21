-- 回滚前先把空间文件处理掉：旧约束无法表达「全租户共享」，直接重建唯一索引会冲突。
-- 这里选择拒绝在有空间文件时回滚，而不是静默删除数据。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_file WHERE scope = 'space') THEN
    RAISE EXCEPTION 'refusing to roll back 0038: space-scoped files still exist';
  END IF;
END $$;

DROP INDEX IF EXISTS ix_user_file_space_updated;
DROP INDEX IF EXISTS ux_user_file_space_path;
DROP INDEX IF EXISTS ux_user_file_personal_path;
ALTER TABLE user_file DROP CONSTRAINT IF EXISTS ck_user_file_scope;
ALTER TABLE user_file DROP COLUMN IF EXISTS scope;
ALTER TABLE user_file ADD CONSTRAINT user_file_tenant_id_user_id_path_key
  UNIQUE (tenant_id, user_id, path);
