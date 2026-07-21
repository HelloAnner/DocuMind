DROP TABLE IF EXISTS vector_jobs;
DROP TABLE IF EXISTS vector_index_versions;
DROP INDEX IF EXISTS idx_chunk_embeddings_index_status;
UPDATE chunk_embeddings
SET embedding_vector = to_jsonb(embedding_values)
WHERE embedding_values IS NOT NULL;
ALTER TABLE chunk_embeddings
    ALTER COLUMN embedding_vector DROP DEFAULT,
    DROP CONSTRAINT IF EXISTS chunk_embeddings_values_dim_check,
    DROP COLUMN IF EXISTS indexed_at,
    DROP COLUMN IF EXISTS index_name,
    DROP COLUMN IF EXISTS index_status,
    DROP COLUMN IF EXISTS embedding_values;
