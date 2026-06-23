SET search_path TO documind, public;

ALTER TABLE document_tables
    ALTER COLUMN row_count DROP DEFAULT,
    ALTER COLUMN col_count DROP DEFAULT,
    ALTER COLUMN headers DROP DEFAULT,
    ALTER COLUMN raw_json DROP DEFAULT,
    ALTER COLUMN quality DROP DEFAULT,
    ALTER COLUMN source_ref DROP DEFAULT;
