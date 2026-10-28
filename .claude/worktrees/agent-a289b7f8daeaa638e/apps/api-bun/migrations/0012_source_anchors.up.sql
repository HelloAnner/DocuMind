CREATE TABLE IF NOT EXISTS document_source_anchors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL,
    format TEXT NOT NULL,
    kind TEXT NOT NULL,
    page INT,
    slide INT,
    block_id UUID,
    table_id UUID,
    cell_range JSONB,
    char_range JSONB,
    bbox JSONB,
    source_ref JSONB NOT NULL DEFAULT '{}',
    text TEXT NOT NULL DEFAULT '',
    text_hash TEXT,
    anchor_quality TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_anchors_doc_parse
    ON document_source_anchors(doc_id, parse_job_id);
CREATE INDEX IF NOT EXISTS idx_source_anchors_block
    ON document_source_anchors(block_id);
CREATE INDEX IF NOT EXISTS idx_source_anchors_tenant_doc
    ON document_source_anchors(tenant_id, doc_id);

CREATE TABLE IF NOT EXISTS chunk_anchor_map (
    chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    anchor_id UUID NOT NULL REFERENCES document_source_anchors(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'primary',
    PRIMARY KEY (chunk_id, anchor_id)
);

CREATE INDEX IF NOT EXISTS idx_chunk_anchor_map_anchor
    ON chunk_anchor_map(anchor_id);

ALTER TABLE document_blocks
    ADD COLUMN IF NOT EXISTS anchor_ids UUID[] NOT NULL DEFAULT '{}';

ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS anchor_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS primary_anchor_id UUID,
    ADD COLUMN IF NOT EXISTS anchor_quality TEXT NOT NULL DEFAULT 'unknown';
