// 移植自 apps/api-rs/src/rag/reranker.rs —— HttpReranker（dashscope / openai 兼容两种请求体）
import type { RerankInput, RerankedChunk, RetrievedChunk } from '../models/rag.ts';
import type { Reranker, RerankProviderKind } from './types.ts';
import { asRecord } from './retriever/es_source.ts';

export type RerankProvider = 'dashscope' | 'openai_compatible';

export function parseRerankProvider(value: string): RerankProvider {
  switch (value.trim().toLowerCase()) {
    case 'dashscope':
      return 'dashscope';
    case 'openai':
    case 'openai_compatible':
    case 'cohere_compatible':
      return 'openai_compatible';
    default:
      throw new Error(`unsupported rerank provider: ${value.trim().toLowerCase()}`);
  }
}

/** 将 types.ts 的具体厂商 kind 映射到 Rust 的两种请求形态。 */
export function rerankProviderFromKind(kind: RerankProviderKind): RerankProvider {
  switch (kind) {
    case 'dashscope':
      return 'dashscope';
    case 'jina':
    case 'cohere':
    case 'siliconflow':
      return 'openai_compatible';
  }
}

function providerAsStr(provider: RerankProvider): string {
  return provider;
}

interface RerankResult {
  index: number;
  score: number;
}

const RERANK_TIMEOUT_SECONDS = 60;

export class HttpReranker implements Reranker {
  private readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly provider: RerankProvider;

  constructor(apiUrl: string, apiKey: string | null, model: string, provider: RerankProvider) {
    if (apiUrl.trim().length === 0) throw new Error('rerank api url is empty');
    if (model.trim().length === 0) throw new Error('rerank model is empty');
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.provider = provider;
  }

  componentName(): string {
    return `${providerAsStr(this.provider)}:${this.model}`;
  }

  private async request(query: string, documents: string[], topN: number): Promise<RerankResult[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey !== null) headers.Authorization = `Bearer ${this.apiKey}`;
    const body =
      this.provider === 'dashscope'
        ? JSON.stringify({
            model: this.model,
            input: { query, documents },
            parameters: { return_documents: false, top_n: topN },
          })
        : JSON.stringify({ model: this.model, query, documents, top_n: topN });
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(RERANK_TIMEOUT_SECONDS * 1000),
    });
    const status = response.status;
    const text = await response.text();
    if (!response.ok) {
      const diagnostic = Array.from(text).slice(0, 1_000).join('');
      throw new Error(`reranker request failed with HTTP ${status} ${response.statusText}: ${diagnostic}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`reranker returned invalid JSON: ${message}`);
    }
    return parseResults(payload);
  }

  async probe(): Promise<void> {
    const results = await this.request(
      'enterprise document retrieval readiness',
      [
        'enterprise document retrieval readiness',
        'unrelated weather observation',
      ],
      1,
    );
    const first = results[0];
    if (first === undefined) {
      throw new Error('reranker readiness probe returned no result');
    }
    if (first.index >= 2 || !Number.isFinite(first.score)) {
      throw new Error('reranker readiness probe returned an invalid result');
    }
  }

  async rerank(input: RerankInput): Promise<RerankedChunk[]> {
    if (input.chunks.length === 0) return [];
    const documents = input.chunks.map(rerankDocumentText);
    const results = await this.request(input.query, documents, Math.max(1, input.top_k));
    results.sort((a, b) => compareDesc(a.score, b.score));

    const reranked: RerankedChunk[] = [];
    for (const result of results.slice(0, Math.max(1, input.top_k))) {
      const chunk = input.chunks[result.index];
      if (chunk === undefined) {
        throw new Error(`reranker returned invalid document index ${result.index}`);
      }
      reranked.push({ chunk, score: result.score, rank: reranked.length + 1 });
    }
    return reranked;
  }
}

/** 与 Rust partial_cmp(...).unwrap_or(Equal) 语义一致：NaN 视为相等。 */
function compareDesc(left: number, right: number): number {
  if (Number.isNaN(left) || Number.isNaN(right)) return 0;
  if (right > left) return 1;
  if (right < left) return -1;
  return 0;
}

export function parseResults(payload: unknown): RerankResult[] {
  const record = asRecord(payload);
  if (record === null) throw new Error('reranker response is missing results');
  let results = record.results;
  if (results === undefined || results === null) {
    const output = asRecord(record.output);
    results = output === null ? undefined : output.results;
  }
  if (!Array.isArray(results)) throw new Error('reranker response is missing results');
  const parsed: RerankResult[] = [];
  for (const item of results) {
    const itemRecord = asRecord(item);
    if (itemRecord === null) throw new Error('reranker returned an invalid result item');
    const index = itemRecord.index;
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      throw new Error('reranker returned an invalid result item');
    }
    const scoreValue = itemRecord.score ?? itemRecord.relevance_score ?? 0;
    if (typeof scoreValue !== 'number') throw new Error('reranker returned an invalid result item');
    parsed.push({ index, score: scoreValue });
  }
  if (parsed.length === 0) throw new Error('reranker returned no results');
  return parsed;
}

function rerankDocumentText(chunk: RetrievedChunk): string {
  return JSON.stringify({
    document_title: chunk.doc_title,
    heading_path: chunk.heading_path,
    content: chunk.content,
  });
}
