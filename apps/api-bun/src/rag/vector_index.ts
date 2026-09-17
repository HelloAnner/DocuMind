// 移植自 apps/api-rs/src/rag/vector_index.rs —— ElasticsearchChunkIndexer：索引生命周期 + bulk + scroll
import type { CharRange, NormalizedBBox } from '../models/source_anchor.ts';
import { toRfc3339 } from '../infra/time.ts';
import { indexDefinition } from './vector_index/schema.ts';

export interface ElasticsearchConfig {
  baseUrl: string;
  indexName: string;
  aliasName: string;
  timeoutSeconds: number;
}

export interface EsRange {
  gte: number;
  lte: number;
}

export interface IndexedChunk {
  chunk_id: string;
  doc_id: string;
  doc_title: string;
  file_type: string;
  kb_id: string;
  tenant_id: string;
  parse_job_id: string;
  chunk_index: number;
  source_type: string;
  content: string;
  heading_path: string[];
  heading_text: string;
  page_range: EsRange | null;
  slide_start: number | null;
  slide_end: number | null;
  token_count: number;
  block_ids: string[];
  table_ids: string[];
  anchor_ids: string[];
  primary_anchor_id: string | null;
  anchor_quality: string;
  anchor_format: string;
  anchor_kind: string;
  anchor_page: number | null;
  anchor_slide: number | null;
  anchor_char_range: CharRange | null;
  anchor_bbox: NormalizedBBox | null;
  anchor_text: string;
  embedding_model: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  created_at: Date;
  embedded_at: Date;
}

/** 与 serde 输出逐字段对齐（snake_case key；时间 RFC3339）。 */
export function indexedChunkToJson(chunk: IndexedChunk): Record<string, unknown> {
  return {
    chunk_id: chunk.chunk_id,
    doc_id: chunk.doc_id,
    doc_title: chunk.doc_title,
    file_type: chunk.file_type,
    kb_id: chunk.kb_id,
    tenant_id: chunk.tenant_id,
    parse_job_id: chunk.parse_job_id,
    chunk_index: chunk.chunk_index,
    source_type: chunk.source_type,
    content: chunk.content,
    heading_path: chunk.heading_path,
    heading_text: chunk.heading_text,
    page_range: chunk.page_range,
    slide_start: chunk.slide_start,
    slide_end: chunk.slide_end,
    token_count: chunk.token_count,
    block_ids: chunk.block_ids,
    table_ids: chunk.table_ids,
    anchor_ids: chunk.anchor_ids,
    primary_anchor_id: chunk.primary_anchor_id,
    anchor_quality: chunk.anchor_quality,
    anchor_format: chunk.anchor_format,
    anchor_kind: chunk.anchor_kind,
    anchor_page: chunk.anchor_page,
    anchor_slide: chunk.anchor_slide,
    anchor_char_range: chunk.anchor_char_range,
    anchor_bbox: chunk.anchor_bbox,
    anchor_text: chunk.anchor_text,
    embedding_model: chunk.embedding_model,
    embedding: chunk.embedding,
    metadata: chunk.metadata,
    created_at: toRfc3339(chunk.created_at),
    embedded_at: toRfc3339(chunk.embedded_at),
  };
}

function statusError(prefix: string, response: Response): Error {
  return new Error(`${prefix}: HTTP ${response.status} ${response.statusText}`);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export class ElasticsearchChunkIndexer {
  private readonly config: ElasticsearchConfig;

  constructor(config: ElasticsearchConfig) {
    if (config.baseUrl.trim().length === 0) throw new Error('elasticsearch url is empty');
    if (config.indexName.trim().length === 0) {
      throw new Error('elasticsearch chunk index name is empty');
    }
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') };
  }

  indexName(): string {
    return this.config.indexName;
  }

  private timeoutMs(): number {
    return this.config.timeoutSeconds * 1000;
  }

  private baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  private indexUrl(): string {
    return `${this.baseUrl()}/${this.config.indexName}`;
  }

  async ensureIndex(dims: number): Promise<void> {
    if (dims === 0) throw new Error('embedding dimension must be greater than zero');

    const indexUrl = this.indexUrl();
    const head = await fetch(indexUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (head.status === 404) {
      const response = await fetch(indexUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(indexDefinition(dims)),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
      if (!response.ok) throw statusError('elasticsearch create index failed', response);
    } else {
      if (!head.ok) throw statusError('elasticsearch head index failed', head);
      await this.validateIndexDimension(dims);
    }
  }

  async resetInactiveIndex(dims: number): Promise<void> {
    if ((await this.aliasTargets()).includes(this.config.indexName)) {
      throw new Error(
        `refusing to reset index ${this.config.indexName} while it is attached to alias ${this.config.aliasName}`,
      );
    }
    const response = await fetch(this.indexUrl(), {
      method: 'DELETE',
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (response.status !== 404 && !response.ok) {
      throw statusError('elasticsearch delete index failed', response);
    }
    await this.ensureIndex(dims);
  }

  async switchAlias(): Promise<string[]> {
    if (this.config.aliasName.trim().length === 0) {
      throw new Error('elasticsearch search alias is empty');
    }
    const previous = await this.aliasTargets();
    const actions: Record<string, unknown>[] = previous
      .filter((index) => index !== this.config.indexName)
      .map((index) => ({ remove: { index, alias: this.config.aliasName } }));
    actions.push({
      add: {
        index: this.config.indexName,
        alias: this.config.aliasName,
        is_write_index: true,
      },
    });
    const response = await fetch(`${this.baseUrl()}/_aliases`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (!response.ok) throw statusError('elasticsearch alias switch failed', response);
    return previous;
  }

  async aliasTargets(): Promise<string[]> {
    const response = await fetch(
      `${this.baseUrl()}/_alias/${this.config.aliasName}`,
      { signal: AbortSignal.timeout(this.timeoutMs()) },
    );
    if (response.status === 404) return [];
    if (!response.ok) throw statusError('elasticsearch alias lookup failed', response);
    const payload = recordOf(await readJson(response));
    if (payload === null) {
      throw new Error('elasticsearch alias response is not an object');
    }
    return Object.keys(payload);
  }

  async bulkIndex(chunks: IndexedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const first = chunks[0];
    if (first === undefined) throw new Error('bulk index called without chunks');
    const dims = first.embedding.length;
    if (chunks.some((chunk) => chunk.embedding.length !== dims)) {
      throw new Error('all indexed chunk embeddings must have the same dimension');
    }
    await this.ensureIndex(dims);

    let body = '';
    for (const chunk of chunks) {
      body += JSON.stringify({
        index: { _index: this.config.indexName, _id: chunk.chunk_id },
      });
      body += '\n';
      body += JSON.stringify(indexedChunkToJson(chunk));
      body += '\n';
    }

    const response = await fetch(`${this.baseUrl()}/_bulk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (!response.ok) throw statusError('elasticsearch bulk request failed', response);
    const payload = recordOf(await readJson(response));
    if (payload === null) throw new Error('elasticsearch bulk response is missing errors');
    const hasErrors = payload.errors;
    if (typeof hasErrors !== 'boolean') {
      throw new Error('elasticsearch bulk response is missing errors');
    }
    if (hasErrors) {
      const items = Array.isArray(payload.items) ? payload.items : [];
      let reason: string | null = null;
      for (const item of items) {
        const itemRecord = recordOf(item);
        const indexRecord = itemRecord === null ? null : recordOf(itemRecord.index);
        if (indexRecord === null) continue;
        const error = indexRecord.error;
        if (error === undefined || error === null) continue;
        const errorRecord = recordOf(error);
        const reasonValue = errorRecord === null ? error : errorRecord.reason ?? error;
        // 与 Rust Value::to_string 一致：字符串带引号，对象序列化为 JSON
        reason = JSON.stringify(reasonValue);
        break;
      }
      throw new Error(
        `elasticsearch bulk index failed: ${reason ?? 'bulk index reported errors'}`,
      );
    }
  }

  async deleteDocumentChunks(docId: string): Promise<number> {
    const response = await fetch(
      `${this.indexUrl()}/_delete_by_query?conflicts=proceed&refresh=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { term: { doc_id: docId } } }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (response.status === 404) return 0;
    if (!response.ok) throw statusError('elasticsearch delete by query failed', response);
    const payload = recordOf(await readJson(response));
    const deleted = payload === null ? undefined : payload.deleted;
    if (typeof deleted !== 'number') {
      throw new Error('elasticsearch delete response is missing deleted');
    }
    return deleted;
  }

  async updateDocumentKb(tenantId: string, docId: string, kbId: string): Promise<number> {
    const response = await fetch(
      `${this.indexUrl()}/_update_by_query?conflicts=proceed&refresh=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(documentKbUpdateBody(tenantId, docId, kbId)),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (response.status === 404) return 0;
    if (!response.ok) throw statusError('elasticsearch update by query failed', response);
    const payload = recordOf(await readJson(response));
    const updated = payload === null ? undefined : payload.updated;
    if (typeof updated !== 'number') {
      throw new Error('elasticsearch update response is missing updated');
    }
    return updated;
  }

  async refresh(): Promise<void> {
    const response = await fetch(`${this.indexUrl()}/_refresh`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (!response.ok) throw statusError('elasticsearch refresh failed', response);
  }

  async count(): Promise<number> {
    const response = await fetch(`${this.indexUrl()}/_count`,
      { signal: AbortSignal.timeout(this.timeoutMs()) },
    );
    if (response.status === 404) return 0;
    if (!response.ok) throw statusError('elasticsearch count failed', response);
    const payload = recordOf(await readJson(response));
    const count = payload === null ? undefined : payload.count;
    if (typeof count !== 'number') {
      throw new Error('elasticsearch count response is missing count');
    }
    return count;
  }

  async chunkIds(): Promise<Set<string>> {
    const response = await fetch(`${this.indexUrl()}/_search?scroll=1m`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 5_000, _source: false, sort: ['_doc'] }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (response.status === 404) return new Set();
    if (!response.ok) throw statusError('elasticsearch scroll search failed', response);
    let payload = recordOf(await readJson(response));
    if (payload === null) throw new Error('elasticsearch scroll response is missing hits');
    const ids = new Set<string>();
    let scrollId = typeof payload._scroll_id === 'string' ? payload._scroll_id : null;
    for (;;) {
      const hitsRecord = recordOf(payload.hits);
      const hits = hitsRecord === null ? null : hitsRecord.hits;
      if (!Array.isArray(hits)) {
        throw new Error('elasticsearch scroll response is missing hits');
      }
      if (hits.length === 0) break;
      for (const hit of hits) {
        const hitRecord = recordOf(hit);
        const id = hitRecord === null ? null : hitRecord._id;
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          throw new Error('elasticsearch chunk document has an invalid _id');
        }
        ids.add(id);
      }
      if (scrollId === null) break;
      const currentScrollId = scrollId;
      const scrollResponse = await fetch(`${this.baseUrl()}/_search/scroll`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scroll: '1m', scroll_id: currentScrollId }),
          signal: AbortSignal.timeout(this.timeoutMs()),
        },
      );
      if (!scrollResponse.ok) {
        throw statusError('elasticsearch scroll continuation failed', scrollResponse);
      }
      payload = recordOf(await readJson(scrollResponse));
      if (payload === null) throw new Error('elasticsearch scroll response is missing hits');
      scrollId = typeof payload._scroll_id === 'string' ? payload._scroll_id : null;
    }
    if (scrollId !== null) {
      await fetch(`${this.baseUrl()}/_search/scroll`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scroll_id: [scrollId] }),
          signal: AbortSignal.timeout(this.timeoutMs()),
        },
      ).catch(() => undefined);
    }
    return ids;
  }

  async countDocumentParse(docId: string, parseJobId: string): Promise<number> {
    const response = await fetch(`${this.indexUrl()}/_count`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: { bool: { filter: [{ term: { doc_id: docId } }, { term: { parse_job_id: parseJobId } }] } },
        }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (response.status === 404) return 0;
    if (!response.ok) throw statusError('elasticsearch document count failed', response);
    const payload = recordOf(await readJson(response));
    const count = payload === null ? undefined : payload.count;
    if (typeof count !== 'number') {
      throw new Error('elasticsearch document count response is missing count');
    }
    return count;
  }

  async deleteIndex(index: string): Promise<void> {
    if (index === this.config.indexName) {
      throw new Error('refusing to delete the active target index');
    }
    const response = await fetch(`${this.baseUrl()}/${index}`,
      {
        method: 'DELETE',
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
    );
    if (response.status === 404) return;
    if (!response.ok) throw statusError('elasticsearch delete index failed', response);
  }

  private async validateIndexDimension(expected: number): Promise<void> {
    const response = await fetch(`${this.indexUrl()}/_mapping/field/embedding`,
      { signal: AbortSignal.timeout(this.timeoutMs()) },
    );
    if (!response.ok) throw statusError('elasticsearch mapping lookup failed', response);
    const payload = recordOf(await readJson(response));
    const indexMapping = payload === null ? null : recordOf(payload[this.config.indexName]);
    const mappings = indexMapping === null ? null : recordOf(indexMapping.mappings);
    const embeddingField = mappings === null ? null : recordOf(mappings.embedding);
    const mapping = embeddingField === null ? null : recordOf(embeddingField.mapping);
    const denseVector = mapping === null ? null : recordOf(mapping.embedding);
    const actual = denseVector === null ? undefined : denseVector.dims;
    if (typeof actual !== 'number') {
      throw new Error('elasticsearch embedding mapping is missing dims');
    }
    if (actual !== expected) {
      throw new Error(
        `elasticsearch index ${this.config.indexName} uses ${actual} dimensions, expected ${expected}`,
      );
    }
  }
}

export function documentKbUpdateBody(
  tenantId: string,
  docId: string,
  kbId: string,
): Record<string, unknown> {
  return {
    query: {
      bool: {
        filter: [
          { term: { tenant_id: tenantId } },
          { term: { doc_id: docId } },
        ],
      },
    },
    script: {
      lang: 'painless',
      source: 'ctx._source.kb_id = params.kb_id',
      params: { kb_id: kbId },
    },
  };
}
