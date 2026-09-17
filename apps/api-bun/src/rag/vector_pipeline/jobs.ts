// 移植自 apps/api-rs/src/rag/vector_pipeline.rs —— process_job / rebuild_index / verify_index_contents
import type { Sql } from 'postgres';
import type { EmbeddingConfig } from '../../config.ts';
import type { JobMetadata, VectorJob } from '../vector_jobs.ts';
import type { ElasticsearchChunkIndexer } from '../vector_index.ts';
import { EmbeddingClient } from '../embedding.ts';
import { indexDocument } from '../vector_document.ts';
import * as vectorJobs from '../vector_jobs.ts';
import { expectedChunkIds, indexer } from '../vector_pipeline.ts';

export async function processJob(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string,
  embeddingClient: EmbeddingClient,
  workerId: string,
  job: VectorJob,
): Promise<JobMetadata> {
  if (job.embeddingModel !== config.model || job.embeddingDim !== config.dimension) {
    throw new Error('vector job model or dimension no longer matches runtime configuration');
  }
  if (job.operation === 'index_document') {
    if (job.docId === null) throw new Error('index_document job is missing doc_id');
    if (job.parseJobId === null) throw new Error('index_document job is missing parse_job_id');
    const target = (await vectorJobs.activeIndex(sql, config.indexAlias)) ?? job.targetIndex;
    const outcome = await indexDocument(
      sql,
      embeddingClient,
      indexer(esUrl, target, config),
      job.docId,
      job.parseJobId,
      config,
    );
    return {
      physical_index: target,
      indexed_chunks: outcome.indexedChunks,
      generated_embeddings: outcome.generatedEmbeddings,
      reused_embeddings: outcome.reusedEmbeddings,
      skipped: outcome.skipped,
    };
  }
  if (job.operation === 'rebuild_index') {
    return rebuildIndex(sql, config, esUrl, embeddingClient, workerId, job);
  }
  throw new Error(`unsupported vector job operation ${job.operation}`);
}

export async function rebuildIndex(
  sql: Sql,
  config: EmbeddingConfig,
  esUrl: string,
  embeddingClient: EmbeddingClient,
  workerId: string,
  job: VectorJob,
): Promise<JobMetadata> {
  const targetIndexer = indexer(esUrl, job.targetIndex, config);
  const attached = await targetIndexer.aliasTargets();
  if (attached.includes(job.targetIndex)) {
    const [expected, actual] = await verifyIndexContents(sql, targetIndexer);
    const previous = await targetIndexer.switchAlias();
    await vectorJobs.activateVersion(sql, config.indexAlias, job.targetIndex, expected, actual);
    for (const retired of previous.filter((index) => index !== job.targetIndex)) {
      await targetIndexer.deleteIndex(retired);
    }
    for (const retired of await vectorJobs.retiredIndexes(sql, config.indexAlias)) {
      if (retired !== job.targetIndex) {
        await targetIndexer.deleteIndex(retired);
      }
    }
    if (config.indexName !== job.targetIndex && !previous.includes(config.indexName)) {
      await targetIndexer.deleteIndex(config.indexName);
    }
    return {
      physical_index: job.targetIndex,
      expected_chunks: expected,
      actual_chunks: actual,
      recovered_alias_activation: true,
      retired_indices: previous,
    };
  }
  await targetIndexer.resetInactiveIndex(config.dimension);
  const documents = await sql.unsafe(
    `SELECT id, latest_parse_job_id
     FROM documents
     WHERE parse_status = 'indexed'
       AND latest_parse_job_id IS NOT NULL AND chunk_count > 0
     ORDER BY updated_at, id`,
  );
  let indexedDocuments = 0;
  for (const raw of documents) {
    const row = raw as Record<string, unknown>;
    await vectorJobs.heartbeat(sql, job.id, workerId);
    const docId = row.id;
    const parseJobId = row.latest_parse_job_id;
    if (typeof docId !== 'string' || typeof parseJobId !== 'string') {
      throw new Error('rebuild_index query returned an unexpected row');
    }
    const outcome = await indexDocument(
      sql,
      embeddingClient,
      targetIndexer,
      docId,
      parseJobId,
      config,
    );
    if (!outcome.skipped) {
      indexedDocuments += 1;
    }
  }
  await targetIndexer.refresh();
  const [expected, actual] = await verifyIndexContents(sql, targetIndexer);
  const previous = await targetIndexer.switchAlias();
  await vectorJobs.activateVersion(sql, config.indexAlias, job.targetIndex, expected, actual);
  for (const retired of previous.filter((index) => index !== job.targetIndex)) {
    await targetIndexer.deleteIndex(retired);
  }
  console.log(
    `[documind][rag] activated rebuilt vector index physical_index=${job.targetIndex} expected=${expected} actual=${actual}`,
  );
  return {
    physical_index: job.targetIndex,
    indexed_documents: indexedDocuments,
    expected_chunks: expected,
    actual_chunks: actual,
    retired_indices: previous,
  };
}

async function verifyIndexContents(
  sql: Sql,
  targetIndexer: ElasticsearchChunkIndexer,
): Promise<[number, number]> {
  const expectedIds = await expectedChunkIds(sql);
  const actualIds = await targetIndexer.chunkIds();
  const missing = setDifference(expectedIds, actualIds).size;
  const stale = setDifference(actualIds, expectedIds).size;
  if (missing > 0 || stale > 0) {
    throw new Error(`vector index has ${missing} missing and ${stale} stale chunks`);
  }
  return [expectedIds.size, actualIds.size];
}

export function setDifference(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) {
    if (!right.has(value)) result.add(value);
  }
  return result;
}
