// 移植自 apps/api-rs/src/rag/retriever.rs —— EsRetriever：dense(knn) + bm25 + RRF 融合
import type { Sql } from 'postgres';
import type { RetrievalInput, RetrievalOutput, RetrievedChunk } from '../models/rag.ts';
import type { Retriever } from './types.ts';
import type { EmbeddingClientConfig } from './embedding.ts';
import { EmbeddingClient } from './embedding.ts';
import { fuseRankedLists, successfulLists } from './retriever/fusion.ts';
import { asRecord, chunkFromEsSource } from './retriever/es_source.ts';

const SEARCH_TIMEOUT_SECONDS = 30;

export class EsRetriever implements Retriever {
  private readonly baseUrl: string;
  private readonly indexName: string;
  private readonly embeddingModel: string;
  private readonly embeddingClient: EmbeddingClient;
  private readonly sql: Sql;

  constructor(
    baseUrl: string,
    indexName: string,
    embeddingConfig: EmbeddingClientConfig,
    embeddingModel: string,
    sql: Sql,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.indexName = indexName;
    this.embeddingModel = embeddingModel;
    this.embeddingClient = new EmbeddingClient(embeddingConfig);
    this.sql = sql;
  }

  componentName(): string {
    return `elasticsearch-hybrid:${this.indexName}`;
  }

  private searchUrl(): string {
    return `${this.baseUrl}/${this.indexName}/_search`;
  }

  private async denseSearch(query: string, input: RetrievalInput): Promise<RetrievedChunk[]> {
    const vector = await this.embeddingClient.embedOne(query);
    const denseTopK = Math.max(1, input.dense_top_k);
    const payload = {
      size: denseTopK,
      _source: true,
      knn: {
        field: 'embedding',
        query_vector: vector,
        k: denseTopK,
        num_candidates: Math.max(input.dense_top_k, input.top_k, 50) * 4,
        filter: [
          { term: { tenant_id: input.tenant_id } },
          { terms: { kb_id: input.effective_kb_ids } },
          { term: { embedding_model: this.embeddingModel } },
        ],
      },
    };
    return this.search(payload, 'dense');
  }

  private async bm25Search(query: string, input: RetrievalInput): Promise<RetrievedChunk[]> {
    const payload = {
      size: Math.max(1, input.bm25_top_k),
      _source: true,
      query: {
        bool: {
          filter: [
            { term: { tenant_id: input.tenant_id } },
            { terms: { kb_id: input.effective_kb_ids } },
            { term: { embedding_model: this.embeddingModel } },
          ],
          must: [{
            multi_match: {
              query,
              fields: ['doc_title^6', 'content^3', 'content.standard^1.2', 'heading_text^1.5'],
              type: 'best_fields',
            },
          }],
        },
      },
    };
    return this.search(payload, 'bm25');
  }

  private async search(
    payload: Record<string, unknown>,
    source: 'dense' | 'bm25',
  ): Promise<RetrievedChunk[]> {
    const response = await fetch(this.searchUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) {
      throw new Error(
        `elasticsearch search request failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body: unknown = await response.json();
    const bodyRecord = asRecord(body);
    const hitsRecord = bodyRecord === null ? null : asRecord(bodyRecord.hits);
    const hits = hitsRecord === null ? null : hitsRecord.hits;
    if (!Array.isArray(hits)) throw new Error('elasticsearch response missing hits.hits');
    const chunks: RetrievedChunk[] = [];
    for (const hit of hits) {
      const hitRecord = asRecord(hit);
      if (hitRecord === null) continue;
      const scoreValue = hitRecord._score;
      const score = typeof scoreValue === 'number' ? scoreValue : 0.0;
      const sourceRecord = asRecord(hitRecord._source);
      if (sourceRecord === null) continue;
      const chunk = chunkFromEsSource(sourceRecord, score, source);
      if (chunk !== null) chunks.push(chunk);
    }
    return chunks;
  }

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    if (input.effective_kb_ids.length === 0 || input.queries.length === 0) {
      return { chunks: [], warnings: [] };
    }
    const denseQueries = [...input.queries];
    const hypothetical = input.hypothetical_answer ?? null;
    if (hypothetical !== null && hypothetical.trim().length > 0) {
      denseQueries.push(hypothetical);
    }
    const denseResults = await Promise.all(
      denseQueries.map((query) => this.denseSearch(query, input)),
    );
    const bm25Results = await Promise.all(
      input.queries.map((query) => this.bm25Search(query, input)),
    );

    const { lists: denseLists, failures: denseFailures } = successfulLists(denseResults, 'dense');
    const { lists: bm25Lists, failures: bm25Failures } = successfulLists(bm25Results, 'bm25');
    for (const failure of [...denseFailures, ...bm25Failures]) {
      console.warn('[documind][rag] retrieval query degraded:', failure);
    }
    if (denseLists.length === 0) {
      throw new Error(
        `vector retrieval failed for every query: ${denseFailures.join('; ')}`,
      );
    }
    const warnings = [...denseFailures, ...bm25Failures];
    let chunks = fuseRankedLists(denseLists, bm25Lists, input.top_k);
    const chunkIds = chunks.map((chunk) => chunk.chunk_id);
    const rows = await this.sql.unsafe(
      `SELECT c.id
       FROM chunks c
       JOIN documents d ON d.id = c.doc_id AND d.latest_parse_job_id = c.parse_job_id
       WHERE c.id = ANY($1)
         AND d.tenant_id = $2
         AND d.kb_id = ANY($3)
         AND d.parse_status = 'indexed'`,
      [chunkIds, input.tenant_id, input.effective_kb_ids],
    );
    const searchableIds = new Set<string>();
    for (const row of rows) {
      const id = (row as Record<string, unknown>).id;
      if (typeof id === 'string') searchableIds.add(id);
    }
    chunks = chunks.filter((chunk) => searchableIds.has(chunk.chunk_id));
    return { chunks, warnings };
  }
}
