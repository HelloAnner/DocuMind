// 移植自 apps/api-rs/src/rag/vector_store.rs —— chunk_embeddings 表的批量写入与文档状态推进
import type { Sql } from 'postgres';
import type { EmbeddingConfig } from '../config.ts';

export interface EmbeddingScope {
  tenantId: string;
  kbId: string;
  docId: string;
  parseJobId: string;
}

export interface EmbeddingBatchItem {
  chunkId: string;
  contentHash: string;
}

export async function reconcileLegacyEmbeddings(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    const converted = (
      await tx.unsafe(
        `WITH legacy_vectors AS (
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
           AND cardinality(legacy.embedding_values) = target.embedding_dim`,
      )
    ).count;
    const failed = (
      await tx.unsafe(
        `UPDATE chunk_embeddings
         SET status = 'failed',
             index_status = 'failed',
             error_message = COALESCE(error_message, 'legacy embedding payload is invalid')
         WHERE embedding_values IS NULL
           AND embedding_vector <> '[]'::jsonb`,
      )
    ).count;
    const compacted = (
      await tx.unsafe(
        `UPDATE chunk_embeddings
         SET embedding_vector = '[]'::jsonb
         WHERE embedding_vector <> '[]'::jsonb`,
      )
    ).count;
    if (converted > 0 || failed > 0 || compacted > 0) {
      console.log(
        `[documind][rag] reconciled legacy embedding storage converted=${converted} failed=${failed} compacted=${compacted}`,
      );
    }
  });
}

export async function markCurrentEmbeddingsIndexed(
  sql: Sql,
  model: string,
  physicalIndex: string,
): Promise<number> {
  const result = await sql.unsafe(
    `UPDATE chunk_embeddings e
     SET index_status = 'indexed',
         index_name = \$1,
         indexed_at = COALESCE(indexed_at, NOW()),
         error_message = NULL
     FROM chunks c
     JOIN documents d
       ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
     WHERE e.chunk_id = c.id
       AND e.embedding_model = \$2
       AND e.status = 'completed'
       AND e.embedding_values IS NOT NULL
       AND d.parse_status = 'indexed'`,
    [physicalIndex, model],
  );
  return result.count;
}

export async function markDocumentEmbedding(
  sql: Sql,
  scope: EmbeddingScope,
  config: EmbeddingConfig,
): Promise<void> {
  await sql.unsafe(
    `UPDATE documents
     SET parse_status = 'embedding',
         metadata = metadata || \$1,
         updated_at = NOW()
     WHERE tenant_id = \$2 AND id = \$3 AND latest_parse_job_id = \$4
       AND parse_status <> 'excluded_from_search'`,
    [
      {
        active_parse_job_id: scope.parseJobId,
        parse_progress: 85,
        embedding_model: config.model,
        embedding_dimension: config.dimension,
      },
      scope.tenantId,
      scope.docId,
      scope.parseJobId,
    ],
  );
  await sql.unsafe(
    `INSERT INTO document_processing_events (tenant_id, doc_id, parse_job_id, stage, status, message, metrics)
     VALUES (\$1, \$2, \$3, 'embedding', 'running', '开始向量化和索引', \$4)`,
    [scope.tenantId, scope.docId, scope.parseJobId, { model: config.model, dimension: config.dimension }],
  );
}

export async function markBatchRunning(
  sql: Sql,
  scope: EmbeddingScope,
  model: string,
  dimension: number,
  items: EmbeddingBatchItem[],
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const item of items) {
      await tx.unsafe(
        `INSERT INTO chunk_embeddings (
            tenant_id, kb_id, doc_id, chunk_id, embedding_model, embedding_dim,
            embedding_vector, embedding_values, content_hash, status,
            index_status, error_message
         )
         VALUES (\$1, \$2, \$3, \$4, \$5, \$6, '[]'::jsonb, NULL, \$7,
                 'running', 'pending', NULL)
         ON CONFLICT (chunk_id, embedding_model) DO UPDATE
         SET embedding_dim = EXCLUDED.embedding_dim,
             embedding_vector = '[]'::jsonb,
             embedding_values = NULL,
             content_hash = EXCLUDED.content_hash,
             status = 'running',
             index_status = 'pending',
             index_name = NULL,
             error_message = NULL,
             embedded_at = NULL,
             indexed_at = NULL`,
        [scope.tenantId, scope.kbId, scope.docId, item.chunkId, model, dimension, item.contentHash],
      );
    }
  });
}

export async function markBatchFailed(
  sql: Sql,
  model: string,
  items: EmbeddingBatchItem[],
  error: string,
): Promise<void> {
  const ids = items.map((item) => item.chunkId);
  await sql.unsafe(
    `UPDATE chunk_embeddings
     SET status = 'failed', error_message = \$1
     WHERE embedding_model = \$2 AND chunk_id = ANY(\$3)`,
    [error, model, ids],
  );
}

export async function saveEmbedding(
  sql: Sql,
  scope: EmbeddingScope,
  model: string,
  item: EmbeddingBatchItem,
  vector: number[],
  embeddedAt: Date,
): Promise<void> {
  await sql.unsafe(
    `UPDATE chunk_embeddings
     SET embedding_values = \$1,
         status = 'completed',
         index_status = 'pending',
         error_message = NULL,
         embedded_at = \$2
     WHERE tenant_id = \$3 AND kb_id = \$4 AND doc_id = \$5
       AND chunk_id = \$6 AND embedding_model = \$7`,
    [vector, embeddedAt, scope.tenantId, scope.kbId, scope.docId, item.chunkId, model],
  );
}

export async function markDocumentIndexed(
  sql: Sql,
  scope: EmbeddingScope,
  config: EmbeddingConfig,
  physicalIndex: string,
  indexedChunks: number,
): Promise<boolean> {
  let updatedCount = 0;
  await sql.begin(async (tx) => {
    const updated = await tx.unsafe(
      `UPDATE documents
       SET parse_status = 'indexed',
           chunk_count = \$1,
           metadata = metadata || \$2,
           updated_at = NOW()
       WHERE tenant_id = \$3 AND id = \$4 AND latest_parse_job_id = \$5
         AND parse_status <> 'excluded_from_search'`,
      [
        indexedChunks,
        {
          active_parse_job_id: scope.parseJobId,
          parse_progress: 100,
          embedding_model: config.model,
          embedding_dimension: config.dimension,
          vector_index: physicalIndex,
          indexed_chunks: indexedChunks,
        },
        scope.tenantId,
        scope.docId,
        scope.parseJobId,
      ],
    );
    updatedCount = updated.count;
    if (updatedCount === 1) {
      await tx.unsafe(
        `UPDATE chunk_embeddings e
         SET index_status = 'indexed', index_name = \$1, indexed_at = NOW(), error_message = NULL
         FROM chunks c
         WHERE e.chunk_id = c.id
           AND c.parse_job_id = \$2
           AND e.embedding_model = \$3
           AND e.status = 'completed'`,
        [physicalIndex, scope.parseJobId, config.model],
      );
      await tx.unsafe(
        `INSERT INTO document_processing_events (tenant_id, doc_id, parse_job_id, stage, status, message, metrics)
         VALUES (\$1, \$2, \$3, 'indexed', 'completed', '向量化和索引完成', \$4)`,
        [scope.tenantId, scope.docId, scope.parseJobId, { indexed_chunks: indexedChunks, index: physicalIndex }],
      );
    }
  });
  return updatedCount === 1;
}

export async function markDocumentTerminalFailure(
  sql: Sql,
  docId: string,
  parseJobId: string | null,
  embeddingModel: string,
  error: string,
): Promise<void> {
  if (parseJobId === null) return;
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE chunk_embeddings e
       SET index_status = 'failed', error_message = \$1
       FROM chunks c
       WHERE e.chunk_id = c.id AND c.doc_id = \$2 AND c.parse_job_id = \$3
         AND e.embedding_model = \$4`,
      [error, docId, parseJobId, embeddingModel],
    );
    await tx.unsafe(
      `UPDATE documents
       SET parse_status = 'embedding_failed',
           metadata = metadata || \$1,
           updated_at = NOW()
       WHERE id = \$2 AND latest_parse_job_id = \$3
         AND parse_status <> 'excluded_from_search'`,
      [
        { parse_progress: 100, error_code: 'VECTOR_JOB_FAILED', error_message: error },
        docId,
        parseJobId,
      ],
    );
    await tx.unsafe(
      `INSERT INTO document_processing_events (tenant_id, doc_id, parse_job_id, stage, status, message, error_code, error_message)
       SELECT tenant_id, id, \$1, 'embedding', 'failed', '向量化或索引失败', 'VECTOR_JOB_FAILED', \$2
       FROM documents WHERE id = \$3 AND latest_parse_job_id = \$1`,
      [parseJobId, error, docId],
    );
  });
}
