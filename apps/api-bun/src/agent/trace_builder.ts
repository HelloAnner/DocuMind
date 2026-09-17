// 移植自 apps/api-rs/src/agent/trace_builder.rs
import { newUuid } from '../infra/uuid.ts';
import type { RerankedChunk, RetrievedChunk } from '../models/rag.ts';
import type { RetrievalTrace } from '../models/trace.ts';

export function retrievedTraces(messageId: string, chunks: RetrievedChunk[]): RetrievalTrace[] {
  return chunks.map((item, index) => ({
    id: newUuid(),
    message_id: messageId,
    chunk_id: item.chunk_id,
    doc_id: item.doc_id,
    source: item.source,
    rank: index + 1,
    score: item.score,
    heading_path: [...item.heading_path],
    page_range: [...item.page_range],
    content_preview: contentPreview(item.content),
  }));
}

export function rerankedTraces(messageId: string, chunks: RerankedChunk[]): RetrievalTrace[] {
  return chunks.map((item, index) => ({
    id: newUuid(),
    message_id: messageId,
    chunk_id: item.chunk.chunk_id,
    doc_id: item.chunk.doc_id,
    source: 'rerank',
    rank: index + 1,
    score: item.score,
    heading_path: [...item.chunk.heading_path],
    page_range: [...item.chunk.page_range],
    content_preview: contentPreview(item.chunk.content),
  }));
}

function contentPreview(content: string): string {
  const MAX_CHARS = 500;
  const chars = [...content];
  let preview = chars.slice(0, MAX_CHARS).join('');
  if (chars.length > MAX_CHARS) preview += '...';
  return preview;
}
