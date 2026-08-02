ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS upload_batch_id UUID;

ALTER TABLE document_parse_jobs
    ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS worker_id TEXT,
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_documents_upload_batch
    ON documents(tenant_id, upload_batch_id, created_at DESC)
    WHERE upload_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_parse_jobs_claim
    ON document_parse_jobs(status, available_at, created_at)
    WHERE status IN ('pending', 'ocr_queued');

CREATE TABLE IF NOT EXISTS document_processing_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'warning')),
    message TEXT NOT NULL,
    metrics JSONB NOT NULL DEFAULT '{}',
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_processing_events_job
    ON document_processing_events(parse_job_id, created_at, id);
