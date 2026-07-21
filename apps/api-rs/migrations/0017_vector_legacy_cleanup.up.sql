-- A rolling deployment can briefly leave an old process writing JSONB vectors
-- after 0016 has run. Reconcile those late writes into the canonical REAL[]
-- column, then release the duplicated JSONB payload.
WITH legacy_vectors AS (
    SELECT source.id,
           array_agg(
               CASE
                   WHEN jsonb_typeof(item.value) = 'number'
                   THEN (item.value #>> '{}')::REAL
               END
               ORDER BY item.ordinality
           ) AS embedding_values,
           bool_and(jsonb_typeof(item.value) = 'number') AS all_numeric
    FROM chunk_embeddings source
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(source.embedding_vector) = 'array'
            THEN source.embedding_vector
            ELSE '[]'::jsonb
        END
    ) WITH ORDINALITY AS item(value, ordinality)
    WHERE source.embedding_values IS NULL
      AND source.embedding_vector <> '[]'::jsonb
    GROUP BY source.id
)
UPDATE chunk_embeddings target
SET embedding_values = legacy.embedding_values
FROM legacy_vectors legacy
WHERE target.id = legacy.id
  AND legacy.all_numeric
  AND cardinality(legacy.embedding_values) = target.embedding_dim;

UPDATE chunk_embeddings
SET status = 'failed',
    index_status = 'failed',
    error_message = COALESCE(error_message, 'legacy embedding payload is invalid')
WHERE embedding_values IS NULL
  AND embedding_vector <> '[]'::jsonb;

UPDATE chunk_embeddings
SET embedding_vector = '[]'::jsonb
WHERE embedding_vector <> '[]'::jsonb;
