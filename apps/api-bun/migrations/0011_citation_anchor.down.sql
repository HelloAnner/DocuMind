ALTER TABLE conversation_citations
    DROP COLUMN IF EXISTS claim_refs,
    DROP COLUMN IF EXISTS location_status,
    DROP COLUMN IF EXISTS anchor;
