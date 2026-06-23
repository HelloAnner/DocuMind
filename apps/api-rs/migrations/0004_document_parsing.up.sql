CREATE TABLE IF NOT EXISTS documents (
  doc_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'uploaded',
  parse_version INT NOT NULL DEFAULT 0,
  latest_parse_job_id UUID,
  chunk_count INT NOT NULL DEFAULT 0,
  table_count INT NOT NULL DEFAULT 0,
  page_count INT,
  uploaded_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_kb_status
  ON documents(kb_id, parse_status);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_updated
  ON documents(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS document_parse_jobs (
  parse_job_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parser_version TEXT NOT NULL,
  parser_config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  quality_score DOUBLE PRECISION,
  page_count INT,
  block_count INT,
  table_count INT,
  char_count INT,
  warnings JSONB NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_parse_jobs_doc
  ON document_parse_jobs(doc_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_parse_results (
  parse_job_id UUID PRIMARY KEY REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parsed_json JSONB NOT NULL,
  parsed_json_object_key TEXT,
  schema_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_blocks (
  block_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  block_index INT NOT NULL,
  block_type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  normalized_text TEXT,
  heading_level INT,
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  page_start INT,
  page_end INT,
  slide_index INT,
  table_id UUID,
  bbox JSONB,
  source_ref JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parse_job_id, block_index)
);

CREATE INDEX IF NOT EXISTS idx_document_blocks_doc_order
  ON document_blocks(doc_id, parse_job_id, block_index);

CREATE INDEX IF NOT EXISTS idx_document_blocks_type
  ON document_blocks(doc_id, block_type);

CREATE TABLE IF NOT EXISTS document_tables (
  table_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  block_id UUID NOT NULL REFERENCES document_blocks(block_id) ON DELETE CASCADE,
  table_index INT NOT NULL,
  title TEXT,
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  page_start INT,
  page_end INT,
  slide_index INT,
  row_count INT NOT NULL,
  col_count INT NOT NULL,
  headers JSONB NOT NULL DEFAULT '[]',
  raw_json JSONB NOT NULL,
  markdown TEXT NOT NULL,
  csv_object_key TEXT,
  quality JSONB NOT NULL DEFAULT '{}',
  source_ref JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_table_cells (
  cell_id UUID PRIMARY KEY,
  table_id UUID NOT NULL REFERENCES document_tables(table_id) ON DELETE CASCADE,
  row_index INT NOT NULL,
  col_index INT NOT NULL,
  rowspan INT NOT NULL DEFAULT 1,
  colspan INT NOT NULL DEFAULT 1,
  text TEXT NOT NULL DEFAULT '',
  normalized_text TEXT,
  is_header BOOLEAN NOT NULL DEFAULT false,
  data_type TEXT NOT NULL DEFAULT 'text',
  bbox JSONB,
  style JSONB NOT NULL DEFAULT '{}',
  source_ref JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_document_table_cells_table_pos
  ON document_table_cells(table_id, row_index, col_index);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id UUID PRIMARY KEY,
  doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
  parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  source_type TEXT NOT NULL,
  content TEXT NOT NULL,
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  page_start INT,
  page_end INT,
  slide_start INT,
  slide_end INT,
  token_count INT NOT NULL,
  block_ids UUID[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parse_job_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_order
  ON chunks(doc_id, parse_job_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_chunks_kb_source
  ON chunks(kb_id, source_type);

CREATE TABLE IF NOT EXISTS chunk_tables (
  chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES document_tables(id) ON DELETE CASCADE,
  row_start INT,
  row_end INT,
  col_start INT,
  col_end INT,
  PRIMARY KEY (chunk_id, table_id)
);

ALTER TABLE documents
  ADD CONSTRAINT documents_latest_parse_job_fk
  FOREIGN KEY (latest_parse_job_id)
  REFERENCES document_parse_jobs(parse_job_id)
  ON DELETE SET NULL;
