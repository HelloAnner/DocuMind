ALTER TABLE document_parse_results
    ADD COLUMN IF NOT EXISTS schema_version TEXT;

UPDATE document_parse_results
SET schema_version = 'parsed-document-v1'
WHERE schema_version IS NULL;

ALTER TABLE document_parse_results
    ALTER COLUMN schema_version SET DEFAULT 'parsed-document-v1',
    ALTER COLUMN schema_version SET NOT NULL;
