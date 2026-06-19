DROP INDEX IF EXISTS idx_chunks_content_prefix;
DROP INDEX IF EXISTS idx_chunks_scope;
DROP INDEX IF EXISTS idx_document_tables_doc;
DROP INDEX IF EXISTS idx_document_blocks_doc;
DROP INDEX IF EXISTS idx_document_parse_jobs_doc;
DROP INDEX IF EXISTS idx_documents_tenant_kb_status;

DROP TABLE IF EXISTS chunk_embeddings;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS document_table_cells;
DROP TABLE IF EXISTS document_tables;
DROP TABLE IF EXISTS document_parse_results;
DROP TABLE IF EXISTS document_blocks;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS fk_documents_latest_parse_job;
DROP TABLE IF EXISTS document_parse_jobs;
DROP TABLE IF EXISTS documents;
