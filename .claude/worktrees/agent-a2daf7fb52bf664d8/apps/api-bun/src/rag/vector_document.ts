// 移植自 apps/api-rs/src/rag/vector_document.rs —— 单文档向量化主流程（复用既有 embedding → 生成缺失 → 写 ES）
import type { Sql } from 'postgres';
import type { EmbeddingConfig } from '../config.ts';
import type { IndexedChunk } from './vector_index.ts';
import type { EmbeddingBatchItem, EmbeddingScope } from './vector_store.ts';
import type { DocumentScope, StoredChunk, StoredEmbedding } from './vector_document/loaders.ts';
import { EmbeddingClient } from './embedding.ts';
import { ElasticsearchChunkIndexer } from './vector_index.ts';
import {
  markBatchFailed,
  markBatchRunning,
  markDocumentEmbedding,
  markDocumentIndexed,
  saveEmbedding,
} from './vector_store.ts';
import { loadChunks, loadDocument, loadEmbeddings } from './vector_document/loaders.ts';
import * as vectorJobs from './vector_jobs.ts';

export interface IndexDocumentOutcome {
  indexedChunks: number;
  generatedEmbeddings: number;
  reusedEmbeddings: number;
  skipped: boolean;
}

export async function indexDocument(
  sql: Sql,
  embeddingClient: EmbeddingClient,
  indexer: ElasticsearchChunkIndexer,
  docId: string,
  parseJobId: string,
  config: EmbeddingConfig,
): Promise<IndexDocumentOutcome> {
  const document = await loadDocument(sql, docId);
  if (document.latestParseJobId !== parseJobId || document.parseStatus === 'excluded_from_search') {
    return { indexedChunks: 0, generatedEmbeddings: 0, reusedEmbeddings: 0, skipped: true };
  }

  const chunks = await loadChunks(sql, docId, parseJobId);
  if (chunks.length === 0) {
    throw new Error(`document ${docId} parse ${parseJobId} has no chunks to index`);
  }
  const scope: EmbeddingScope = {
    tenantId: document.tenantId,
    kbId: document.kbId,
    docId,
    parseJobId,
  };
  await markDocumentEmbedding(sql, scope, config);

  const existing = await loadEmbeddings(sql, docId, config.model, config.dimension);
  const vectors = new Map<string, StoredEmbedding>();
  const missing: Array<{ chunk: StoredChunk; input: string; hash: string }> = [];
  const reusedCopies: Array<{ chunkId: string; hash: string; embedding: StoredEmbedding }> = [];
  for (const chunk of chunks) {
    const input = embeddingInput(document.title, chunk);
    const hash = sha256Hex(new TextEncoder().encode(input));
    const byChunk = existing.byChunk.get(chunk.chunkId);
    if (byChunk !== undefined && byChunk.contentHash === hash) {
      vectors.set(chunk.chunkId, byChunk);
    } else {
      const byHash = existing.byHash.get(hash);
      if (byHash !== undefined) {
        vectors.set(chunk.chunkId, byHash);
        reusedCopies.push({ chunkId: chunk.chunkId, hash, embedding: byHash });
      } else {
        missing.push({ chunk, input, hash });
      }
    }
  }

  if (reusedCopies.length > 0) {
    const items: EmbeddingBatchItem[] = reusedCopies.map(({ chunkId, hash }) => ({
      chunkId,
      contentHash: hash,
    }));
    await markBatchRunning(sql, scope, config.model, config.dimension, items);
    for (const [i, item] of items.entries()) {
      const copy = reusedCopies[i]!;
      await saveEmbedding(
        sql,
        scope,
        config.model,
        item,
        copy.embedding.vector,
        copy.embedding.embeddedAt,
      );
    }
  }

  let generated = 0;
  const batchSize = embeddingClient.batchSize();
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    const batchItems: EmbeddingBatchItem[] = batch.map(({ chunk, hash }) => ({
      chunkId: chunk.chunkId,
      contentHash: hash,
    }));
    await markBatchRunning(sql, scope, config.model, config.dimension, batchItems);
    const inputs = batch.map(({ input }) => input);
    let generatedVectors: number[][];
    try {
      generatedVectors = await embeddingClient.embedBatch(inputs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markBatchFailed(sql, config.model, batchItems, message);
      throw error;
    }
    if (generatedVectors.length !== batch.length) {
      throw new Error(
        `embedding provider returned ${generatedVectors.length} vectors for ${batch.length} chunks`,
      );
    }
    const now = new Date();
    for (const [i, entry] of batch.entries()) {
      const vector = generatedVectors[i]!;
      validateVector(vector, config.dimension);
      await saveEmbedding(sql, scope, config.model, batchItems[i]!, vector, now);
      vectors.set(entry.chunk.chunkId, {
        vector,
        contentHash: entry.hash,
        embeddedAt: now,
      });
      generated += 1;
    }
  }

  const indexedChunks: IndexedChunk[] = [];
  for (const chunk of chunks) {
    const embedding = vectors.get(chunk.chunkId);
    if (embedding === undefined) {
      throw new Error(`chunk ${chunk.chunkId} is missing an embedding`);
    }
    indexedChunks.push(toIndexedChunk(document, docId, parseJobId, chunk, embedding, config));
  }

  await indexer.ensureIndex(config.dimension);
  await indexer.deleteDocumentChunks(docId);
  for (let start = 0; start < indexedChunks.length; start += 500) {
    await indexer.bulkIndex(indexedChunks.slice(start, start + 500));
  }
  await indexer.refresh();
  const actual = await indexer.countDocumentParse(docId, parseJobId);
  if (actual !== indexedChunks.length) {
    throw new Error(
      `elasticsearch indexed ${actual} chunks for document ${docId}, expected ${indexedChunks.length}`,
    );
  }
  if (!(await markDocumentIndexed(sql, scope, config, indexer.indexName(), actual))) {
    await indexer.deleteDocumentChunks(docId);
    await vectorJobs.refreshActiveVersionCounts(sql, indexer.indexName(), await indexer.count());
    return { indexedChunks: 0, generatedEmbeddings: 0, reusedEmbeddings: 0, skipped: true };
  }
  await vectorJobs.refreshActiveVersionCounts(sql, indexer.indexName(), await indexer.count());

  return {
    indexedChunks: actual,
    generatedEmbeddings: generated,
    reusedEmbeddings: indexedChunks.length - generated,
    skipped: false,
  };
}

export function embeddingInput(title: string, chunk: StoredChunk): string {
  let content = chunk.content;
  if (content.startsWith('【上文】')) {
    const separator = content.indexOf('\n\n');
    if (separator !== -1) content = content.slice(separator + 2);
  }
  const nextSeparator = content.indexOf('\n\n【下文】');
  if (nextSeparator !== -1) content = content.slice(0, nextSeparator);
  const body = content
    .split(/\r?\n/)
    .filter((line) =>
      !line.startsWith('标题路径：') && !line.startsWith('页码：') && !line.startsWith('Slide：'),
    )
    .join('\n');
  const parts: string[] = [`文档：${title}`];
  if (chunk.headingPath.length > 0) {
    parts.push(`章节：${chunk.headingPath.join(' / ')}`);
  }
  parts.push(body.trim());
  return parts.join('\n');
}

function toIndexedChunk(
  document: DocumentScope,
  docId: string,
  parseJobId: string,
  chunk: StoredChunk,
  embedding: StoredEmbedding,
  config: EmbeddingConfig,
): IndexedChunk {
  return {
    chunk_id: chunk.chunkId,
    doc_id: docId,
    doc_title: document.title,
    file_type: document.fileType,
    kb_id: document.kbId,
    tenant_id: document.tenantId,
    parse_job_id: parseJobId,
    chunk_index: chunk.chunkIndex,
    source_type: chunk.sourceType,
    content: chunk.content,
    heading_path: chunk.headingPath,
    heading_text: chunk.headingPath.join(' / '),
    page_range: esRange(chunk.pageRange),
    slide_start: metadataI32(chunk.metadata, 'slide_start'),
    slide_end: metadataI32(chunk.metadata, 'slide_end'),
    token_count: chunk.tokenCount,
    block_ids: chunk.blockIds,
    table_ids: chunk.tableIds,
    anchor_ids: chunk.anchorIds,
    primary_anchor_id: chunk.primaryAnchorId,
    anchor_quality: chunk.anchorQuality,
    anchor_format: chunk.anchorFormat ?? document.fileType,
    anchor_kind: chunk.anchorKind ?? chunk.sourceType,
    anchor_page: chunk.anchorPage,
    anchor_slide: chunk.anchorSlide,
    anchor_char_range: chunk.anchorCharRange,
    anchor_bbox: chunk.anchorBBox,
    anchor_text: chunk.anchorText ?? '',
    anchors: chunk.anchors,
    embedding_model: config.model,
    embedding: embedding.vector,
    metadata: chunk.metadata,
    created_at: chunk.createdAt,
    embedded_at: embedding.embeddedAt,
  };
}

function esRange(pages: number[]): { gte: number; lte: number } | null {
  if (pages.length === 0) return null;
  return { gte: Math.min(...pages), lte: Math.max(...pages) };
}

function metadataI32(metadata: Record<string, unknown>, key: string): number | null {
  const direct = metadata[key];
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct;
  const nested = metadata.chunk_metadata;
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    const value = (nested as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

export function validateVector(vector: number[], dimension: number): void {
  if (vector.length !== dimension) {
    throw new Error(
      `embedding dimension ${vector.length} does not match configured ${dimension}`,
    );
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error('embedding contains a non-finite value');
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}
