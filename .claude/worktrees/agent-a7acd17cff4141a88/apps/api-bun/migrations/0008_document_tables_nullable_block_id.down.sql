SET search_path TO documind, public;

ALTER TABLE document_tables
    ALTER COLUMN block_id SET NOT NULL;
