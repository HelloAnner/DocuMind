// 移植自 apps/api-rs/src/rag/vector_jobs.rs —— vector_jobs 表：入队、claim 租约、完成/失败、索引版本状态
import type { Sql, TransactionSql } from 'postgres';
import type { EmbeddingConfig } from '../config.ts';

export interface VectorJob {
  id: string;
  operation: string;
  tenantId: string | null;
  kbId: string | null;
  docId: string | null;
  parseJobId: string | null;
  embeddingModel: string;
  embeddingDim: number;
  targetIndex: string;
  attemptCount: number;
  maxAttempts: number;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('unexpected non-string column in vector_jobs row');
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number') throw new Error('unexpected non-numeric column in vector_jobs row');
  return value;
}

export async function enqueueDocument(
  sql: Sql,
  tenantId: string,
  kbId: string,
  docId: string,
  parseJobId: string,
  targetIndex: string,
  config: EmbeddingConfig,
  force: boolean,
): Promise<string> {
  const dedupeKey = `index:${parseJobId}:${config.model}`;
  const rows = await sql.unsafe(
    `INSERT INTO vector_jobs (
        dedupe_key, operation, tenant_id, kb_id, doc_id, parse_job_id,
        embedding_model, embedding_dim, target_index, max_attempts
     )
     VALUES (\$1, 'index_document', \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9)
     ON CONFLICT (dedupe_key) DO UPDATE
     SET target_index = EXCLUDED.target_index,
         max_attempts = EXCLUDED.max_attempts,
         status = CASE
             WHEN vector_jobs.status IN ('running', 'pending') THEN vector_jobs.status
             WHEN \$10 THEN 'pending'
             ELSE vector_jobs.status
         END,
         attempt_count = CASE WHEN \$10 THEN 0 ELSE vector_jobs.attempt_count END,
         available_at = CASE WHEN \$10 THEN NOW() ELSE vector_jobs.available_at END,
         error_message = CASE WHEN \$10 THEN NULL ELSE vector_jobs.error_message END,
         published_at = CASE WHEN \$10 THEN NULL ELSE vector_jobs.published_at END,
         completed_at = CASE WHEN \$10 THEN NULL ELSE vector_jobs.completed_at END,
         updated_at = NOW()
     RETURNING id`,
    [dedupeKey, tenantId, kbId, docId, parseJobId, config.model, config.dimension, targetIndex, Math.max(1, config.retryMax), force],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined || typeof row.id !== 'string') {
    throw new Error('enqueue vector job returned no id');
  }
  return row.id;
}

export async function enqueueRebuild(
  sql: Sql,
  targetIndex: string,
  config: EmbeddingConfig,
): Promise<string> {
  const dedupeKey = `rebuild:${targetIndex}`;
  const rows = await sql.unsafe(
    `INSERT INTO vector_jobs (
        dedupe_key, operation, embedding_model, embedding_dim,
        target_index, max_attempts
     )
     VALUES (\$1, 'rebuild_index', \$2, \$3, \$4, \$5)
     ON CONFLICT (dedupe_key) DO UPDATE
     SET status = CASE
             WHEN vector_jobs.status IN ('running', 'pending') THEN vector_jobs.status
             ELSE 'pending'
         END,
         attempt_count = CASE
             WHEN vector_jobs.status IN ('running', 'pending') THEN vector_jobs.attempt_count
             ELSE 0
         END,
         available_at = NOW(),
         error_message = NULL,
         published_at = NULL,
         dead_lettered_at = NULL,
         completed_at = NULL,
         updated_at = NOW()
     RETURNING id`,
    [dedupeKey, config.model, config.dimension, targetIndex, Math.max(1, config.retryMax)],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined || typeof row.id !== 'string') {
    throw new Error('enqueue vector rebuild returned no id');
  }
  return row.id;
}

export async function recoverLeases(sql: Sql): Promise<number> {
  const result = await sql.unsafe(
    `UPDATE vector_jobs
     SET status = 'pending',
         attempt_count = GREATEST(attempt_count - 1, 0),
         worker_id = NULL,
         lease_expires_at = NULL,
         available_at = NOW(),
         published_at = NULL,
         error_message = COALESCE(error_message, 'worker lease expired'),
         updated_at = NOW()
     WHERE status = 'running'
       AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`,
  );
  return result.count;
}

export async function refreshActiveVersionCounts(
  sql: Sql,
  physicalIndex: string,
  actualChunks: number,
): Promise<void> {
  await sql.unsafe(
    `UPDATE vector_index_versions
     SET expected_chunks = (
             SELECT COUNT(*)::bigint
             FROM chunks c
             JOIN documents d
               ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
             WHERE d.parse_status = 'indexed'
         ),
         indexed_chunks = \$1
     WHERE physical_index = \$2 AND status = 'active'`,
    [actualChunks, physicalIndex],
  );
}

export async function cancelDocument(sql: Sql, docId: string): Promise<number> {
  const result = await sql.unsafe(
    `UPDATE vector_jobs
     SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL,
         published_at = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE doc_id = \$1 AND status IN ('pending', 'running')`,
    [docId],
  );
  return result.count;
}

/** 对应 Rust 的 tx.rollback() + Ok(None)：仅用于 claim 冲突，不吞其他错误。 */
class ClaimConflict extends Error {}

export async function claimNext(sql: Sql, workerId: string): Promise<VectorJob | null> {
  return claim(sql, workerId, null);
}

export async function claimById(sql: Sql, workerId: string, id: string): Promise<VectorJob | null> {
  return claim(sql, workerId, id);
}

async function claim(
  sql: Sql,
  workerId: string,
  requestedId: string | null,
): Promise<VectorJob | null> {
  const claimed = await sql
    .begin(async (tx) => {
      const rows = await tx.unsafe(
        `SELECT id, operation, tenant_id, kb_id, doc_id, parse_job_id,
                embedding_model, embedding_dim, target_index,
                attempt_count, max_attempts
         FROM vector_jobs
         WHERE status = 'pending' AND available_at <= NOW()
           AND (\$1::uuid IS NULL OR id = \$1)
         ORDER BY CASE WHEN operation = 'rebuild_index' THEN 0 ELSE 1 END,
                  created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [requestedId],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      const id = asString(row.id);
      const updated = await tx.unsafe(
        `UPDATE vector_jobs
         SET status = 'running',
             attempt_count = attempt_count + 1,
             worker_id = \$1,
             lease_expires_at = NOW() + INTERVAL '10 minutes',
             error_message = NULL,
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = \$2 AND status = 'pending'`,
        [workerId, id],
      );
      if (updated.count !== 1) throw new ClaimConflict();
      return {
        id,
        operation: asString(row.operation),
        tenantId: asNullableString(row.tenant_id),
        kbId: asNullableString(row.kb_id),
        docId: asNullableString(row.doc_id),
        parseJobId: asNullableString(row.parse_job_id),
        embeddingModel: asString(row.embedding_model),
        embeddingDim: asNumber(row.embedding_dim),
        targetIndex: asString(row.target_index),
        attemptCount: asNumber(row.attempt_count) + 1,
        maxAttempts: asNumber(row.max_attempts),
      } satisfies VectorJob;
    })
    .catch((error: unknown) => {
      if (error instanceof ClaimConflict) return null;
      throw error;
    });
  return claimed;
}

export async function heartbeat(sql: Sql, id: string, workerId: string): Promise<void> {
  await sql.unsafe(
    `UPDATE vector_jobs
     SET lease_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
     WHERE id = \$1 AND status = 'running' AND worker_id = \$2`,
    [id, workerId],
  );
}

export async function complete(sql: Sql, id: string, metadata: Record<string, unknown>): Promise<void> {
  await sql.unsafe(
    `UPDATE vector_jobs
     SET status = 'completed',
         lease_expires_at = NULL,
         worker_id = NULL,
         published_at = NULL,
         error_message = NULL,
         metadata = metadata || \$1,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = \$2 AND status = 'running'`,
    [metadata, id],
  );
}

export async function pendingForPublish(sql: Sql, limit: number): Promise<string[]> {
  try {
    const rows = await sql.unsafe(
      `SELECT id FROM vector_jobs
       WHERE status = 'pending' AND available_at <= NOW()
         AND (published_at IS NULL OR published_at < NOW() - INTERVAL '5 minutes')
       ORDER BY CASE WHEN operation = 'rebuild_index' THEN 0 ELSE 1 END,
                created_at
       LIMIT \$1`,
      [Math.min(1_000, Math.max(1, limit))],
    );
    return rows.map((row) => asString((row as Record<string, unknown>).id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load vector jobs for RabbitMQ publication: ${message}`);
  }
}

export async function markPublished(sql: Sql, id: string): Promise<void> {
  await sql.unsafe(
    `UPDATE vector_jobs
     SET published_at = NOW(), publish_attempt_count = publish_attempt_count + 1,
         updated_at = NOW()
     WHERE id = \$1 AND status = 'pending'`,
    [id],
  );
}

export async function failedForDeadLetter(sql: Sql, limit: number): Promise<string[]> {
  try {
    const rows = await sql.unsafe(
      `SELECT id FROM vector_jobs
       WHERE status = 'failed' AND dead_lettered_at IS NULL
       ORDER BY completed_at, created_at
       LIMIT \$1`,
      [Math.min(1_000, Math.max(1, limit))],
    );
    return rows.map((row) => asString((row as Record<string, unknown>).id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load terminal vector jobs for dead-letter publication: ${message}`);
  }
}

export async function markDeadLettered(sql: Sql, id: string): Promise<void> {
  await sql.unsafe(
    `UPDATE vector_jobs SET dead_lettered_at = NOW(), updated_at = NOW()
     WHERE id = \$1 AND status = 'failed'`,
    [id],
  );
}

export async function fail(sql: Sql, job: VectorJob, message: string): Promise<boolean> {
  const retry = job.attemptCount < job.maxAttempts;
  const delaySeconds = Math.min(300, Math.max(10, 5 * 2 ** Math.min(job.attemptCount, 6)));
  const result = await sql.unsafe(
    `UPDATE vector_jobs
     SET status = CASE WHEN \$1 THEN 'pending' ELSE 'failed' END,
         available_at = CASE
             WHEN \$1 THEN NOW() + make_interval(secs => \$2)
             ELSE available_at
         END,
         lease_expires_at = NULL,
         worker_id = NULL,
         published_at = NULL,
         dead_lettered_at = CASE WHEN \$1 THEN NULL ELSE dead_lettered_at END,
         error_message = \$3,
         completed_at = CASE WHEN \$1 THEN NULL ELSE NOW() END,
         updated_at = NOW()
     WHERE id = \$4 AND status = 'running'`,
    [retry, delaySeconds, message, job.id],
  );
  return retry || result.count === 0;
}

export async function activeIndex(sql: Sql, alias: string): Promise<string | null> {
  try {
    const rows = await sql.unsafe(
      `SELECT physical_index FROM vector_index_versions
       WHERE index_alias = \$1 AND status = 'active'`,
      [alias],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? null : asNullableString(row.physical_index);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load active vector index: ${message}`);
  }
}

export async function retiredIndexes(sql: Sql, alias: string): Promise<string[]> {
  try {
    const rows = await sql.unsafe(
      `SELECT physical_index FROM vector_index_versions
       WHERE index_alias = \$1 AND status = 'retired'`,
      [alias],
    );
    return rows.map((row) => asString((row as Record<string, unknown>).physical_index));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load retired vector indices: ${message}`);
  }
}

export async function createBuildingVersion(
  tx: TransactionSql,
  alias: string,
  physicalIndex: string,
  config: EmbeddingConfig,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO vector_index_versions (
        index_alias, physical_index, embedding_model, embedding_dim,
        schema_version, status
     )
     VALUES (\$1, \$2, \$3, \$4, \$5, 'building')
     ON CONFLICT (physical_index) DO UPDATE
     SET status = CASE
             WHEN vector_index_versions.status = 'active' THEN 'active'
             ELSE 'building'
         END,
         error_message = NULL`,
    [alias, physicalIndex, config.model, config.dimension, config.indexSchemaVersion],
  );
}

export async function activateVersion(
  sql: Sql,
  alias: string,
  physicalIndex: string,
  expected: number,
  actual: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE vector_index_versions
       SET status = 'retired', retired_at = NOW()
       WHERE index_alias = \$1 AND status = 'active' AND physical_index <> \$2`,
      [alias, physicalIndex],
    );
    await tx.unsafe(
      `UPDATE vector_index_versions
       SET status = 'active', expected_chunks = \$1, indexed_chunks = \$2,
           error_message = NULL, activated_at = NOW(), retired_at = NULL
       WHERE physical_index = \$3`,
      [expected, actual, physicalIndex],
    );
  });
}

export async function markVersionFailed(
  sql: Sql,
  physicalIndex: string,
  error: string,
): Promise<void> {
  await sql.unsafe(
    `UPDATE vector_index_versions
     SET status = 'failed', error_message = \$1
     WHERE physical_index = \$2 AND status <> 'active'`,
    [error, physicalIndex],
  );
}
