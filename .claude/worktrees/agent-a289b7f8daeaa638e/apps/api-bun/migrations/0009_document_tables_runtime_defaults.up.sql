SET search_path TO documind, public;

ALTER TABLE document_tables
    ALTER COLUMN row_count SET DEFAULT 0,
    ALTER COLUMN col_count SET DEFAULT 0,
    ALTER COLUMN headers SET DEFAULT '[]'::jsonb,
    ALTER COLUMN raw_json SET DEFAULT '[]'::jsonb,
    ALTER COLUMN quality SET DEFAULT '{}'::jsonb,
    ALTER COLUMN source_ref SET DEFAULT '{}'::jsonb;
