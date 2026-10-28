DROP TABLE IF EXISTS chunk_anchor_map;
DROP TABLE IF EXISTS document_source_anchors;

ALTER TABLE document_blocks
    DROP COLUMN IF EXISTS anchor_ids;

ALTER TABLE chunks
    DROP COLUMN IF EXISTS anchor_ids,
    DROP COLUMN IF EXISTS primary_anchor_id,
    DROP COLUMN IF EXISTS anchor_quality;
