// 移植自 apps/api-rs/src/rag/vector_index/schema.rs —— ES 索引 mapping 定义与物理索引名

export function indexDefinition(dims: number): Record<string, unknown> {
  return {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
    },
    mappings: {
      properties: {
        chunk_id: { type: 'keyword' },
        doc_id: { type: 'keyword' },
        doc_title: {
          type: 'text',
          analyzer: 'cjk',
          search_analyzer: 'cjk',
          fields: {
            keyword: { type: 'keyword', ignore_above: 32766 },
          },
        },
        file_type: { type: 'keyword' },
        kb_id: { type: 'keyword' },
        tenant_id: { type: 'keyword' },
        parse_job_id: { type: 'keyword' },
        chunk_index: { type: 'integer' },
        source_type: { type: 'keyword' },
        content: {
          type: 'text',
          analyzer: 'cjk',
          search_analyzer: 'cjk',
          fields: {
            standard: { type: 'text', analyzer: 'standard' },
            keyword: { type: 'keyword', ignore_above: 32766 },
          },
        },
        heading_path: { type: 'keyword' },
        heading_text: { type: 'text', analyzer: 'cjk', search_analyzer: 'cjk' },
        page_range: { type: 'integer_range' },
        slide_start: { type: 'integer' },
        slide_end: { type: 'integer' },
        token_count: { type: 'integer' },
        block_ids: { type: 'keyword' },
        table_ids: { type: 'keyword' },
        anchor_ids: { type: 'keyword' },
        primary_anchor_id: { type: 'keyword' },
        anchor_quality: { type: 'keyword' },
        anchor_format: { type: 'keyword' },
        anchor_kind: { type: 'keyword' },
        anchor_page: { type: 'integer' },
        anchor_slide: { type: 'integer' },
        anchor_char_range: { type: 'object' },
        anchor_bbox: { type: 'object' },
        anchor_text: { type: 'text', index: false },
        embedding_model: { type: 'keyword' },
        embedding: {
          type: 'dense_vector',
          dims,
          index: true,
          similarity: 'cosine',
          index_options: {
            type: 'hnsw',
            m: 16,
            ef_construction: 200,
          },
        },
        created_at: { type: 'date' },
        embedded_at: { type: 'date' },
      },
    },
  };
}

export function physicalIndexName(
  prefix: string,
  model: string,
  dims: number,
  schemaVersion: number,
): string {
  return `${sanitizeIndexPart(prefix)}-v${schemaVersion}-${sanitizeIndexPart(model)}-${dims}`;
}

function sanitizeIndexPart(value: string): string {
  let sanitized = Array.from(value.trim().toLowerCase())
    .map((character) =>
      /[a-z0-9]/i.test(character) || character === '-' || character === '_'
        ? character
        : '-',
    )
    .join('');
  while (sanitized.includes('--')) {
    sanitized = sanitized.replaceAll('--', '-');
  }
  return sanitized.replace(/^[-_]+|[-_]+$/g, '');
}
