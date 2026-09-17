DROP TABLE IF EXISTS chunk_tables;

DROP INDEX IF EXISTS idx_chunks_source_type;
ALTER TABLE chunks
    DROP COLUMN IF EXISTS overlap_next_block_ids,
    DROP COLUMN IF EXISTS overlap_prev_block_ids,
    DROP COLUMN IF EXISTS table_ids,
    DROP COLUMN IF EXISTS block_ids,
    DROP COLUMN IF EXISTS source_type;

DROP INDEX IF EXISTS idx_cleaned_blocks_removed;
DROP INDEX IF EXISTS idx_cleaned_blocks_doc_order;
DROP TABLE IF EXISTS cleaned_blocks;
