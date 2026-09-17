CREATE TABLE IF NOT EXISTS cleaned_blocks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    block_id UUID NOT NULL REFERENCES document_blocks(id) ON DELETE CASCADE,
    block_index INT NOT NULL,
    block_type TEXT NOT NULL,
    cleaned_text TEXT NOT NULL DEFAULT '',
    is_removed BOOLEAN NOT NULL DEFAULT FALSE,
    remove_reason TEXT,
    cleaning_ops TEXT[] NOT NULL DEFAULT '{}',
    heading_path TEXT[] NOT NULL DEFAULT '{}',
    page_range INT[] NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(parse_job_id, block_id)
);

CREATE INDEX IF NOT EXISTS idx_cleaned_blocks_doc_order
    ON cleaned_blocks(doc_id, parse_job_id, block_index);

CREATE INDEX IF NOT EXISTS idx_cleaned_blocks_removed
    ON cleaned_blocks(parse_job_id, is_removed);

ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'paragraph',
    ADD COLUMN IF NOT EXISTS block_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS table_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS overlap_prev_block_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS overlap_next_block_ids UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_chunks_source_type
    ON chunks(kb_id, source_type);

CREATE TABLE IF NOT EXISTS chunk_tables (
    chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES document_tables(id) ON DELETE CASCADE,
    row_start INT,
    row_end INT,
    col_start INT,
    col_end INT,
    PRIMARY KEY (chunk_id, table_id)
);
