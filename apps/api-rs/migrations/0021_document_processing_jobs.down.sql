DROP TABLE IF EXISTS document_processing_events;
DROP INDEX IF EXISTS idx_document_parse_jobs_claim;
DROP INDEX IF EXISTS idx_documents_upload_batch;
ALTER TABLE document_parse_jobs
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS heartbeat_at,
    DROP COLUMN IF EXISTS worker_id,
    DROP COLUMN IF EXISTS available_at,
    DROP COLUMN IF EXISTS max_attempts,
    DROP COLUMN IF EXISTS attempt_count;
ALTER TABLE documents DROP COLUMN IF EXISTS upload_batch_id;
