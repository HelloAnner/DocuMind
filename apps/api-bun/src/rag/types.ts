// 移植自 apps/api-rs/src/rag/{retriever,reranker,context}.rs 的端口定义
import type { ContextInput, EvidencePack, RerankInput, RerankedChunk, RetrievalInput, RetrievalOutput } from '../models/rag.ts';

export interface Retriever {
  retrieve(input: RetrievalInput): Promise<RetrievalOutput>;
  componentName(): string;
}

export interface Reranker {
  rerank(input: RerankInput): Promise<RerankedChunk[]>;
  componentName(): string;
}

export interface ContextAssembler {
  assemble(input: ContextInput): Promise<EvidencePack>;
  componentName(): string;
}

export type RerankProviderKind = 'dashscope' | 'jina' | 'cohere' | 'siliconflow';
