// 移植自 apps/api-rs/src/rag/vector_pipeline.rs
// —— VectorConsistency 快照 / 物理索引命名与 alias 切换 / 重建调度 / 后台 worker 主循环。
//
// 与 Rust 的差异（明确记录，不做静默兜底）：
// Rust 用 vector_queue.rs（lapin / RabbitMQ）作为可选唤醒通道，DB 轮询始终在跑；
// Bun 端口未引入 AMQP 客户端依赖，startVectorWorker 的 rabbitmqUrl 参数只记录告警，
// 作业消费依赖 claimNext 数据库轮询 —— 等价于 Rust 在 "RabbitMQ 不可用，database polling
// remains active" 分支的行为。
import type { Sql } from 'postgres';
import type { EmbeddingConfig } from '../config.ts';
import { newUuid } from '../infra/uuid.ts';
import { EmbeddingClient, embeddingClientConfigFrom } from './embedding.ts';
import { ElasticsearchChunkIndexer } from './vector_index.ts';
import { physicalIndexName } from './vector_index/schema.ts';
import * as vectorJobs from './vector_jobs.ts';
import { processJob, setDifference } from './vector_pipeline/jobs.ts';
import * as vectorStore from './vector_store.ts';

/** 与 Rust VectorConsistency 的 serde 输出逐字段对齐（snake_case）。 */
export interface VectorConsistency {
  index_alias: string;
  physical_index: string | null;
  expected_chunks: number;
  actual_chunks: number;
  missing_chunks: number;
  stale_chunks: number;
  missing_or_stale_chunks: number;
  consistent: boolean;
}

const WORKER_LEASE_RECOVERY_MS = 30_000;
const WORKER_CONSISTENCY_INTERVAL_MS = 60_000;

/**
 * 对应 Rust start_vector_worker：校验前置条件后 fire-and-forget 启动后台循环。
 * 与 Rust 相同，worker 异常退出只记录日志，由入口决定是否重启。
 */
export function startVectorWorker(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string | null,
  rabbitmqUrl: string | null,
): void {
  if (!config.enabled) {
    console.log('[documind][rag] vector worker disabled because embedding is disabled');
    return;
  }
  if (esUrl === null) {
    console.error('[documind][rag] vector worker disabled because ELASTICSEARCH_URL is missing');
    return;
  }
  if (rabbitmqUrl !== null) {
    console.warn(
      '[documind][rag] RabbitMQ vector queue is not available in the Bun port; database polling remains active',
    );
  }
  void runWorker(sql, config, esUrl).catch((error: unknown) => {
    console.error(
      `[documind][rag] vector worker stopped unexpectedly: ${describeError(error)}`,
    );
  });
}

/** 对应 Rust enqueue_document：目标索引取当前 active 索引，缺失时用期望索引。 */
export async function enqueueDocument(
  sql: Sql,
  tenantId: string,
  kbId: string,
  docId: string,
  parseJobId: string,
  config: EmbeddingConfig,
  force: boolean,
): Promise<string> {
  const target = (await vectorJobs.activeIndex(sql, config.indexAlias)) ?? desiredIndex(config);
  return vectorJobs.enqueueDocument(
    sql, tenantId, kbId, docId, parseJobId, target, config, force,
  );
}

/** 对应 Rust schedule_rebuild：返回 [job_id, target_index]。 */
export async function scheduleRebuild(
  sql: Sql,
  config: EmbeddingConfig,
): Promise<[string, string]> {
  if (await hasOpenRebuild(sql, config.indexAlias)) {
    const rows = await sql.unsafe(
      `SELECT id, target_index FROM vector_jobs
       WHERE operation = 'rebuild_index' AND status IN ('pending', 'running')
         AND embedding_model = $1
       ORDER BY created_at DESC LIMIT 1`,
      [config.model],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new Error('open rebuild job disappeared while scheduling a rebuild');
    }
    return [asColumnString(row.id, 'id'), asColumnString(row.target_index, 'target_index')];
  }
  const base = desiredIndex(config);
  const active = await vectorJobs.activeIndex(sql, config.indexAlias);
  const target = active === base ? `${base}-r${Date.now()}` : base;
  await sql.begin(async (tx) => {
    await vectorJobs.createBuildingVersion(tx, config.indexAlias, target, config);
  });
  const id = await vectorJobs.enqueueRebuild(sql, target, config);
  return [id, target];
}

/** 对应 Rust consistency：逐 chunk 比对（可发现 stale），需要 ES scroll。 */
export async function consistency(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string,
): Promise<VectorConsistency> {
  const physicalIndex = await vectorJobs.activeIndex(sql, config.indexAlias);
  const expectedIds = await expectedChunkIds(sql);
  const actualIds = physicalIndex === null
    ? new Set<string>()
    : await indexer(esUrl, physicalIndex, config).chunkIds();
  const missing = setDifference(expectedIds, actualIds).size;
  const stale = setDifference(actualIds, expectedIds).size;
  return {
    index_alias: config.indexAlias,
    physical_index: physicalIndex,
    expected_chunks: expectedIds.size,
    actual_chunks: actualIds.size,
    missing_chunks: missing,
    stale_chunks: stale,
    missing_or_stale_chunks: missing + stale,
    consistent: missing === 0 && stale === 0,
  };
}

/** 对应 Rust quick_consistency：只比数量，健康检查用。 */
export async function quickConsistency(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string,
): Promise<VectorConsistency> {
  const physicalIndex = await vectorJobs.activeIndex(sql, config.indexAlias);
  const rows = await sql.unsafe(
    `SELECT COUNT(*)::bigint AS count
     FROM chunks c
     JOIN documents d ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
     WHERE d.parse_status = 'indexed'`,
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error('expected chunk count query returned no row');
  const expected = Number(row.count ?? 0);
  const actual = physicalIndex === null
    ? 0
    : await indexer(esUrl, physicalIndex, config).count();
  const missing = Math.max(0, expected - actual);
  const stale = Math.max(0, actual - expected);
  return {
    index_alias: config.indexAlias,
    physical_index: physicalIndex,
    expected_chunks: expected,
    actual_chunks: actual,
    missing_chunks: missing,
    stale_chunks: stale,
    missing_or_stale_chunks: missing + stale,
    consistent: expected === actual,
  };
}

/** 对应 Rust expected_chunk_ids（jobs.ts 的 verify_index_contents 也复用）。 */
export async function expectedChunkIds(sql: Sql): Promise<Set<string>> {
  try {
    const rows = await sql.unsafe(
      `SELECT c.id
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
       WHERE d.parse_status = 'indexed'`,
    );
    const ids = new Set<string>();
    for (const raw of rows) {
      ids.add(asColumnString((raw as Record<string, unknown>).id, 'id'));
    }
    return ids;
  } catch (error) {
    throw new Error(
      `failed to load current indexed chunk identifiers: ${describeError(error)}`,
    );
  }
}

/** 对应 Rust indexer：每个物理索引一个 indexer，alias 始终指向 config.index_alias。 */
export function indexer(
  esUrl: string,
  physicalIndex: string,
  config: EmbeddingConfig,
): ElasticsearchChunkIndexer {
  return new ElasticsearchChunkIndexer({
    baseUrl: esUrl,
    indexName: physicalIndex,
    aliasName: config.indexAlias,
    timeoutSeconds: 120,
  });
}

/** 对应 Rust desired_index。 */
export function desiredIndex(config: EmbeddingConfig): string {
  return physicalIndexName(
    config.indexName,
    config.model,
    config.dimension,
    config.indexSchemaVersion,
  );
}

/** 对应 Rust run_worker：claim → process → complete/fail，空转时周期性 lease 回收与一致性校验。 */
async function runWorker(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string,
): Promise<void> {
  const embeddingClient = new EmbeddingClient(embeddingClientConfigFrom(config));
  const workerId = `vector-worker-${newUuid()}`;
  await vectorStore.reconcileLegacyEmbeddings(sql);
  await recoverExpiredLeases(sql);
  await bootstrapJobs(sql, config, esUrl);

  const poll = Math.min(60_000, Math.max(250, config.workerPollMs));
  const leaseRecoveryTicks = Math.max(1, Math.floor(WORKER_LEASE_RECOVERY_MS / Math.max(1, poll)));
  let idleTicks = 0;
  for (;;) {
    const job = await vectorJobs.claimNext(sql, workerId);
    if (job === null) {
      idleTicks += 1;
      if (idleTicks % leaseRecoveryTicks === 0) {
        await recoverExpiredLeases(sql);
      }
      if (idleTicks * poll >= WORKER_CONSISTENCY_INTERVAL_MS) {
        idleTicks = 0;
        try {
          await ensureConsistency(sql, config, esUrl);
        } catch (error) {
          console.warn(
            `[documind][rag] periodic vector consistency check failed: ${describeError(error)}`,
          );
        }
      }
      await sleep(poll);
      continue;
    }
    idleTicks = 0;
    const result = await processJob(sql, config, esUrl, embeddingClient, workerId, job).then(
      (metadata) => ({ ok: true as const, metadata }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (result.ok) {
      await vectorJobs.complete(sql, job.id, result.metadata);
      continue;
    }
    const message = describeError(result.error);
    const retry = await vectorJobs.fail(sql, job, message);
    console.warn(
      `[documind][rag] vector job failed job_id=${job.id} operation=${job.operation} retry=${retry} error=${message}`,
    );
    if (!retry) {
      if (job.docId !== null) {
        await vectorStore.markDocumentTerminalFailure(
          sql, job.docId, job.parseJobId, config.model, message,
        );
      }
      if (job.operation === 'rebuild_index') {
        await vectorJobs.markVersionFailed(sql, job.targetIndex, message);
      }
    }
  }
}

async function recoverExpiredLeases(sql: Sql): Promise<void> {
  const recovered = await vectorJobs.recoverLeases(sql);
  if (recovered > 0) {
    console.warn(`[documind][rag] recovered expired vector job leases: ${recovered}`);
  }
}

/** 对应 Rust bootstrap_jobs：先保证 alias 指向期望索引，再补排队 chunked/embedding 文档。 */
async function bootstrapJobs(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string,
): Promise<void> {
  const desired = desiredIndex(config);
  const aliasTargets = await indexer(esUrl, desired, config).aliasTargets();
  const active = await vectorJobs.activeIndex(sql, config.indexAlias);
  const aliasReady = aliasTargets.length === 1 && aliasTargets[0] === desired;
  if (active !== desired || !aliasReady) {
    await scheduleRebuild(sql, config);
  } else {
    await ensureConsistency(sql, config, esUrl);
  }

  const rows = await sql.unsafe(
    `SELECT tenant_id, kb_id, id, latest_parse_job_id
     FROM documents
     WHERE parse_status IN ('chunked', 'embedding')
       AND latest_parse_job_id IS NOT NULL AND chunk_count > 0`,
  );
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    await enqueueDocument(
      sql,
      asColumnString(row.tenant_id, 'tenant_id'),
      asColumnString(row.kb_id, 'kb_id'),
      asColumnString(row.id, 'id'),
      asColumnString(row.latest_parse_job_id, 'latest_parse_job_id'),
      config,
      true,
    );
  }
}

/** 对应 Rust ensure_consistency：一致则回填 embedding index 状态，漂移则调度重建。 */
async function ensureConsistency(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string,
): Promise<void> {
  const snapshot = await consistency(sql, config, esUrl);
  if (snapshot.consistent) {
    if (snapshot.physical_index !== null) {
      await vectorStore.markCurrentEmbeddingsIndexed(sql, config.model, snapshot.physical_index);
      await vectorJobs.refreshActiveVersionCounts(
        sql, snapshot.physical_index, snapshot.actual_chunks,
      );
    }
  } else if (!(await hasOpenRebuild(sql, config.indexAlias))) {
    console.warn(
      `[documind][rag] vector index drift detected; scheduling rebuild expected=${snapshot.expected_chunks} actual=${snapshot.actual_chunks}`,
    );
    await scheduleRebuild(sql, config);
  }
}

async function hasOpenRebuild(sql: Sql, alias: string): Promise<boolean> {
  const rows = await sql.unsafe(
    `SELECT EXISTS(
        SELECT 1 FROM vector_jobs j
        JOIN vector_index_versions v ON v.physical_index = j.target_index
        WHERE j.operation = 'rebuild_index' AND j.status IN ('pending', 'running')
          AND v.index_alias = $1
     ) AS exists`,
    [alias],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error('open rebuild check returned no row');
  return row.exists === true;
}

function asColumnString(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw new Error(`unexpected non-string column ${column} in vector pipeline row`);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 与 Rust anyhow "{error:#}" 对齐：拼接 Error.cause 链。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const messages: string[] = [error.message];
    let cause: unknown = error.cause;
    while (cause instanceof Error) {
      messages.push(cause.message);
      cause = cause.cause;
    }
    return messages.join(': ');
  }
  return String(error);
}
