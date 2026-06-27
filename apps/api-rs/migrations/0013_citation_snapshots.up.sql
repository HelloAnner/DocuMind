CREATE TABLE IF NOT EXISTS conversation_citation_snapshots (
    citation_id UUID PRIMARY KEY REFERENCES conversation_citations(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL,
    parse_job_id UUID NOT NULL,
    anchor_id UUID,
    citation_index INT NOT NULL,
    quote TEXT,
    anchor_snapshot JSONB NOT NULL,
    claim_refs JSONB NOT NULL DEFAULT '[]',
    source_status TEXT NOT NULL,
    location_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_citation_snapshots_message
    ON conversation_citation_snapshots(message_id, citation_index ASC);

CREATE INDEX IF NOT EXISTS idx_citation_snapshots_doc_parse
    ON conversation_citation_snapshots(doc_id, parse_job_id);
