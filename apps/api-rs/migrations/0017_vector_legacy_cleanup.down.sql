UPDATE chunk_embeddings
SET embedding_vector = to_jsonb(embedding_values)
WHERE embedding_values IS NOT NULL;
