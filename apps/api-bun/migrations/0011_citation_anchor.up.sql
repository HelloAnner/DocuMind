ALTER TABLE conversation_citations
    ADD COLUMN IF NOT EXISTS anchor JSONB,
    ADD COLUMN IF NOT EXISTS location_status TEXT NOT NULL DEFAULT 'unavailable',
    ADD COLUMN IF NOT EXISTS claim_refs JSONB NOT NULL DEFAULT '[]';
