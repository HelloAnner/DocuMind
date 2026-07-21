ALTER TABLE chunk_embeddings
    ADD COLUMN IF NOT EXISTS embedding_values REAL[],
    ADD COLUMN IF NOT EXISTS index_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS index_name TEXT,
    ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;

UPDATE chunk_embeddings e
SET embedding_values = converted.embedding_values
FROM (
    SELECT source.id,
           array_agg(item.value::REAL ORDER BY item.ordinality) AS embedding_values
    FROM chunk_embeddings source
    CROSS JOIN LATERAL jsonb_array_elements_text(source.embedding_vector)
        WITH ORDINALITY AS item(value, ordinality)
    WHERE source.embedding_values IS NULL
    GROUP BY source.id
) converted
WHERE e.id = converted.id;

-- Historical demo rows used a one-element placeholder with embedding_dim=64.
-- Keep those rows diagnosable without allowing them into the canonical store.
UPDATE chunk_embeddings
SET embedding_values = NULL,
    status = 'failed',
    error_message = COALESCE(error_message, 'legacy embedding dimension mismatch')
WHERE embedding_values IS NOT NULL
  AND cardinality(embedding_values) <> embedding_dim;

UPDATE chunk_embeddings
SET index_status = CASE WHEN status = 'completed' THEN 'indexed' ELSE 'failed' END,
    indexed_at = CASE WHEN status = 'completed' THEN embedded_at ELSE NULL END
WHERE index_name IS NULL;

-- Keep the legacy JSONB column rollout-compatible, but release its large TOAST
-- payload after REAL[] becomes the canonical representation.
UPDATE chunk_embeddings
SET embedding_vector = '[]'::jsonb
WHERE embedding_values IS NOT NULL
  AND embedding_vector <> '[]'::jsonb;

ALTER TABLE chunk_embeddings
    ALTER COLUMN embedding_vector SET DEFAULT '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chunk_embeddings_values_dim_check'
          AND conrelid = 'chunk_embeddings'::regclass
    ) THEN
        ALTER TABLE chunk_embeddings
            ADD CONSTRAINT chunk_embeddings_values_dim_check
            CHECK (
                embedding_values IS NULL
                OR cardinality(embedding_values) = embedding_dim
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_index_status
    ON chunk_embeddings(index_status, index_name, embedding_model);

CREATE TABLE IF NOT EXISTS vector_index_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    index_alias TEXT NOT NULL,
    physical_index TEXT NOT NULL UNIQUE,
    embedding_model TEXT NOT NULL,
    embedding_dim INT NOT NULL,
    schema_version INT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('building', 'active', 'retired', 'failed')),
    expected_chunks BIGINT NOT NULL DEFAULT 0,
    indexed_chunks BIGINT NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_index_versions_active_alias
    ON vector_index_versions(index_alias)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS vector_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dedupe_key TEXT NOT NULL UNIQUE,
    operation TEXT NOT NULL CHECK (operation IN ('index_document', 'rebuild_index')),
    tenant_id UUID,
    kb_id UUID,
    doc_id UUID,
    parse_job_id UUID,
    embedding_model TEXT NOT NULL,
    embedding_dim INT NOT NULL,
    target_index TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    attempt_count INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at TIMESTAMPTZ,
    worker_id TEXT,
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    published_at TIMESTAMPTZ,
    publish_attempt_count INT NOT NULL DEFAULT 0,
    dead_lettered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vector_jobs_claim
    ON vector_jobs(status, available_at, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_vector_jobs_document
    ON vector_jobs(doc_id, parse_job_id, created_at DESC);
