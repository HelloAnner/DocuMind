// 移植自 apps/api-rs/src/rag/embedding.rs —— OpenAI 兼容 /v1/embeddings 客户端（batch + 重试 + 校验）
import type { EmbeddingConfig } from '../config.ts';

export interface EmbeddingClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  batchSize: number;
  timeoutSeconds: number;
  retryMax: number;
}

export function embeddingClientConfigFrom(config: EmbeddingConfig): EmbeddingClientConfig {
  const apiKey = config.apiKey;
  if (apiKey === null || apiKey === undefined) {
    throw new Error('embedding api key is missing: set EMBED_API_KEY, LLM_API, or LLM_API_KEY');
  }
  if (config.model.trim().length === 0) throw new Error('embedding model is empty');
  if (config.baseUrl.trim().length === 0) throw new Error('embedding base url is empty');
  return {
    baseUrl: config.baseUrl,
    apiKey,
    model: config.model,
    batchSize: Math.min(100, Math.max(1, config.batchSize)),
    timeoutSeconds: 120,
    retryMax: Math.max(1, config.retryMax),
  };
}

interface EmbeddingData {
  embedding: number[];
  index?: number;
}

interface EmbeddingResponse {
  data: EmbeddingData[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class EmbeddingClient {
  readonly config: EmbeddingClientConfig;

  constructor(config: EmbeddingClientConfig) {
    this.config = config;
  }

  model(): string {
    return this.config.model;
  }

  batchSize(): number {
    return this.config.batchSize;
  }

  async embedOne(text: string): Promise<number[]> {
    const vectors = await this.embedBatch([text]);
    const vector = vectors.pop();
    if (vector === undefined) throw new Error('embedding provider returned no vector');
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error('embedding input contains empty text');
    }

    let payload: EmbeddingResponse | null = null;
    for (let attempt = 1; attempt <= this.config.retryMax; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.embeddingsUrl(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: this.config.model, input: texts }),
          signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000),
        });
      } catch (error) {
        if (attempt === this.config.retryMax) throw error;
        await sleep(retryDelayMillis(attempt));
        continue;
      }
      if (response.ok) {
        payload = parseEmbeddingResponse(await response.json());
        break;
      }
      const status = response.status;
      const retryable = status === 429 || status >= 500;
      const bodyText = await response.text().catch(() => '<failed to read response body>');
      const body = Array.from(bodyText).slice(0, 1_000).join('');
      if (!retryable || attempt === this.config.retryMax) {
        throw new Error(
          `embedding provider returned HTTP ${status} ${response.statusText}: ${body}`,
        );
      }
      await sleep(retryDelayMillis(attempt));
    }

    if (payload === null) {
      throw new Error('embedding retry loop completed without a response');
    }
    if (payload.data.length !== texts.length) {
      throw new Error(
        `embedding provider returned ${payload.data.length} vectors for ${texts.length} inputs`,
      );
    }

    const ordered: number[][] = Array.from({ length: texts.length }, () => []);
    for (const [fallbackIndex, item] of payload.data.entries()) {
      const index = item.index ?? fallbackIndex;
      if (index >= ordered.length || index < 0) {
        throw new Error(`embedding provider returned out-of-range index ${index}`);
      }
      if (item.embedding.length === 0) {
        throw new Error(`embedding provider returned empty vector at index ${index}`);
      }
      ordered[index] = item.embedding;
    }
    if (ordered.some((vector) => vector.length === 0)) {
      throw new Error('embedding provider response missed one or more vectors');
    }
    return ordered;
  }

  embeddingsUrl(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    if (base.endsWith('/embeddings')) return base;
    return `${base}/embeddings`;
  }
}

function retryDelayMillis(attempt: number): number {
  return Math.min(250 * 2 ** Math.min(attempt, 6), 8_000);
}

function parseEmbeddingResponse(value: unknown): EmbeddingResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('embedding provider returned an invalid JSON response');
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error('embedding provider returned an invalid JSON response');
  }
  const items: EmbeddingData[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('embedding provider returned an invalid JSON response');
    }
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.embedding) || record.embedding.some((v) => typeof v !== 'number')) {
      throw new Error('embedding provider returned an invalid JSON response');
    }
    const index = record.index;
    if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index))) {
      throw new Error('embedding provider returned an invalid JSON response');
    }
    items.push({ embedding: record.embedding as number[], ...(index !== undefined ? { index: index as number } : {}) });
  }
  return { data: items };
}
