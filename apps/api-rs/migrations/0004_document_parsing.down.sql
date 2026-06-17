ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_latest_parse_job_fk;
DROP TABLE IF EXISTS chunk_tables;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS document_table_cells;
DROP TABLE IF EXISTS document_tables;
DROP TABLE IF EXISTS document_blocks;
DROP TABLE IF EXISTS document_parse_results;
DROP TABLE IF EXISTS document_parse_jobs;
DROP TABLE IF EXISTS documents;
