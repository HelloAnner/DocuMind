ALTER TABLE user_file ADD CONSTRAINT uq_user_file_tenant UNIQUE (id, tenant_id);
ALTER TABLE conversation_message_file
  DROP CONSTRAINT conversation_message_file_file_id_tenant_id_user_id_fkey;
ALTER TABLE conversation_message_file
  ADD CONSTRAINT conversation_message_file_file_tenant_fkey
  FOREIGN KEY (file_id, tenant_id) REFERENCES user_file(id, tenant_id) ON DELETE CASCADE;
