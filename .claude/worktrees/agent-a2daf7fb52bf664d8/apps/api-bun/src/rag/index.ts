// 对应 apps/api-rs/src/rag/mod.rs —— rag 模块统一出口（barrel）。
export * from './types.ts';
export * from './context.ts';
export * from './embedding.ts';
export * from './reranker.ts';
export * from './retriever.ts';
export * from './retriever/es_source.ts';
export * from './retriever/fusion.ts';
export * from './vector_document.ts';
export * from './vector_document/loaders.ts';
export * from './vector_index.ts';
export * from './vector_index/schema.ts';
export * from './vector_jobs.ts';
export * from './vector_pipeline/jobs.ts';
export {
  startVectorWorker,
  scheduleRebuild,
  consistency,
  quickConsistency,
  expectedChunkIds,
  indexer,
  desiredIndex,
} from './vector_pipeline.ts';
export type { VectorConsistency } from './vector_pipeline.ts';
// Rust 中 vector_pipeline::enqueue_document 与 vector_jobs::enqueue_document 同名，
// barrel 里重命名以避免冲突；vector_jobs 版本由上方 export * 提供。
export { enqueueDocument as enqueueIndexDocument } from './vector_pipeline.ts';
