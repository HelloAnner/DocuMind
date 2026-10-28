DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM conversation_message_file mf
    JOIN user_file f ON f.id = mf.file_id AND f.tenant_id = mf.tenant_id
    WHERE f.user_id <> mf.user_id
  ) THEN
    RAISE EXCEPTION 'Cannot rollback shared file references while cross-owner attachments exist';
  END IF;
END $$;
ALTER TABLE conversation_message_file DROP CONSTRAINT conversation_message_file_file_tenant_fkey;
ALTER TABLE conversation_message_file
  ADD CONSTRAINT conversation_message_file_file_id_tenant_id_user_id_fkey
  FOREIGN KEY (file_id, tenant_id, user_id) REFERENCES user_file(id, tenant_id, user_id) ON DELETE CASCADE;
ALTER TABLE user_file DROP CONSTRAINT uq_user_file_tenant;
