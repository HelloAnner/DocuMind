DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'documents' AND column_name = 'doc_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'documents' AND column_name = 'id'
    ) THEN
        ALTER TABLE documents RENAME COLUMN doc_id TO id;
    END IF;
END $$;

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS file_name TEXT,
    ADD COLUMN IF NOT EXISTS mime_type TEXT,
    ADD COLUMN IF NOT EXISTS file_size BIGINT,
    ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE documents
SET file_size_bytes = COALESCE(file_size_bytes, file_size, 0),
    created_by = COALESCE(created_by, uploaded_by),
    created_at = COALESCE(created_at, uploaded_at, NOW()),
    updated_at = COALESCE(updated_at, uploaded_at, NOW()),
    metadata = metadata
        || jsonb_build_object('original_filename', file_name)
        || jsonb_build_object('mime_type', mime_type)
WHERE file_size_bytes IS NULL OR created_at IS NULL OR metadata = '{}'::jsonb;

ALTER TABLE documents
    ALTER COLUMN file_size_bytes SET DEFAULT 0,
    ALTER COLUMN file_size_bytes SET NOT NULL,
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN created_at SET NOT NULL,
    ALTER COLUMN updated_at SET DEFAULT NOW(),
    ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE documents
    ALTER COLUMN file_name DROP NOT NULL,
    ALTER COLUMN mime_type DROP NOT NULL,
    ALTER COLUMN file_size DROP NOT NULL,
    ALTER COLUMN file_sha256 DROP NOT NULL,
    ALTER COLUMN storage_key DROP NOT NULL;

ALTER TABLE document_parse_jobs
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS kb_id UUID REFERENCES knowledge_base(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS parse_identity TEXT,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

UPDATE document_parse_jobs j
SET tenant_id = COALESCE(j.tenant_id, d.tenant_id),
    kb_id = COALESCE(j.kb_id, d.kb_id),
    parse_identity = COALESCE(j.parse_identity, j.parse_job_id::text),
    completed_at = COALESCE(j.completed_at, j.finished_at)
FROM documents d
WHERE d.id = j.doc_id;

ALTER TABLE document_parse_jobs
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN kb_id SET NOT NULL,
    ALTER COLUMN parse_identity SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_blocks' AND column_name = 'block_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_blocks' AND column_name = 'id'
    ) THEN
        ALTER TABLE document_blocks RENAME COLUMN block_id TO id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_blocks' AND column_name = 'text'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_blocks' AND column_name = 'content'
    ) THEN
        ALTER TABLE document_blocks RENAME COLUMN text TO content;
    END IF;
END $$;

ALTER TABLE document_blocks
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS kb_id UUID REFERENCES knowledge_base(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS page_start INT,
    ADD COLUMN IF NOT EXISTS page_end INT,
    ADD COLUMN IF NOT EXISTS page_range INT[] NOT NULL DEFAULT '{}';

UPDATE document_blocks b
SET tenant_id = COALESCE(b.tenant_id, d.tenant_id),
    kb_id = COALESCE(b.kb_id, d.kb_id),
    page_range = CASE
        WHEN COALESCE(array_length(b.page_range, 1), 0) > 0 THEN b.page_range
        WHEN b.page_start IS NOT NULL AND b.page_end IS NOT NULL THEN ARRAY[b.page_start, b.page_end]
        WHEN b.page_start IS NOT NULL THEN ARRAY[b.page_start]
        WHEN b.page_end IS NOT NULL THEN ARRAY[b.page_end]
        ELSE '{}'
    END
FROM documents d
WHERE d.id = b.doc_id;

ALTER TABLE document_blocks
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN kb_id SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_tables' AND column_name = 'table_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_tables' AND column_name = 'id'
    ) THEN
        ALTER TABLE document_tables RENAME COLUMN table_id TO id;
    END IF;
END $$;

ALTER TABLE document_tables
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS kb_id UUID REFERENCES knowledge_base(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS block_id UUID,
    ADD COLUMN IF NOT EXISTS title TEXT,
    ADD COLUMN IF NOT EXISTS page_start INT,
    ADD COLUMN IF NOT EXISTS page_end INT,
    ADD COLUMN IF NOT EXISTS slide_index INT,
    ADD COLUMN IF NOT EXISTS row_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS col_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS headers JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS raw_json JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS quality JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS source_ref JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS page_range INT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS cells JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

UPDATE document_tables t
SET tenant_id = COALESCE(t.tenant_id, d.tenant_id),
    kb_id = COALESCE(t.kb_id, d.kb_id),
    page_range = CASE
        WHEN COALESCE(array_length(t.page_range, 1), 0) > 0 THEN t.page_range
        WHEN t.page_start IS NOT NULL AND t.page_end IS NOT NULL THEN ARRAY[t.page_start, t.page_end]
        WHEN t.page_start IS NOT NULL THEN ARRAY[t.page_start]
        WHEN t.page_end IS NOT NULL THEN ARRAY[t.page_end]
        ELSE '{}'
    END,
    cells = CASE WHEN t.cells = '[]'::jsonb THEN COALESCE(t.raw_json, '[]'::jsonb) ELSE t.cells END,
    metadata = CASE
        WHEN t.metadata = '{}'::jsonb THEN jsonb_build_object(
            'block_id', t.block_id,
            'title', t.title,
            'headers', t.headers,
            'row_count', t.row_count,
            'col_count', t.col_count,
            'quality', t.quality,
            'source_ref', t.source_ref,
            'slide', t.slide_index
        )
        ELSE t.metadata
    END
FROM documents d
WHERE d.id = t.doc_id;

ALTER TABLE document_tables
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN kb_id SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_table_cells' AND column_name = 'cell_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_table_cells' AND column_name = 'id'
    ) THEN
        ALTER TABLE document_table_cells RENAME COLUMN cell_id TO id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_table_cells' AND column_name = 'rowspan'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_table_cells' AND column_name = 'row_span'
    ) THEN
        ALTER TABLE document_table_cells RENAME COLUMN rowspan TO row_span;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_table_cells' AND column_name = 'colspan'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'document_table_cells' AND column_name = 'col_span'
    ) THEN
        ALTER TABLE document_table_cells RENAME COLUMN colspan TO col_span;
    END IF;
END $$;

ALTER TABLE document_table_cells
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS kb_id UUID REFERENCES knowledge_base(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS doc_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS parse_job_id UUID REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS normalized_text TEXT,
    ADD COLUMN IF NOT EXISTS is_header BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS data_type TEXT NOT NULL DEFAULT 'text',
    ADD COLUMN IF NOT EXISTS bbox JSONB,
    ADD COLUMN IF NOT EXISTS style JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS source_ref JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

UPDATE document_table_cells c
SET tenant_id = COALESCE(c.tenant_id, t.tenant_id),
    kb_id = COALESCE(c.kb_id, t.kb_id),
    doc_id = COALESCE(c.doc_id, t.doc_id),
    parse_job_id = COALESCE(c.parse_job_id, t.parse_job_id),
    metadata = CASE
        WHEN c.metadata = '{}'::jsonb THEN jsonb_build_object(
            'normalized_text', c.normalized_text,
            'is_header', c.is_header,
            'data_type', c.data_type,
            'bbox', c.bbox,
            'style', c.style,
            'source_ref', c.source_ref
        )
        ELSE c.metadata
    END
FROM document_tables t
WHERE t.id = c.table_id;

ALTER TABLE document_table_cells
    ALTER COLUMN tenant_id SET NOT NULL,
    ALTER COLUMN kb_id SET NOT NULL,
    ALTER COLUMN doc_id SET NOT NULL,
    ALTER COLUMN parse_job_id SET NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'chunks' AND column_name = 'chunk_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'chunks' AND column_name = 'id'
    ) THEN
        ALTER TABLE chunks RENAME COLUMN chunk_id TO id;
    END IF;
END $$;

ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS page_start INT,
    ADD COLUMN IF NOT EXISTS page_end INT,
    ADD COLUMN IF NOT EXISTS page_range INT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS slide_start INT,
    ADD COLUMN IF NOT EXISTS slide_end INT,
    ADD COLUMN IF NOT EXISTS table_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS overlap_prev_block_ids UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS overlap_next_block_ids UUID[] NOT NULL DEFAULT '{}';

UPDATE chunks c
SET tenant_id = COALESCE(c.tenant_id, d.tenant_id),
    page_range = CASE
        WHEN COALESCE(array_length(c.page_range, 1), 0) > 0 THEN c.page_range
        WHEN c.page_start IS NOT NULL AND c.page_end IS NOT NULL THEN ARRAY[c.page_start, c.page_end]
        WHEN c.page_start IS NOT NULL THEN ARRAY[c.page_start]
        WHEN c.page_end IS NOT NULL THEN ARRAY[c.page_end]
        ELSE '{}'
    END,
    table_ids = CASE
        WHEN COALESCE(array_length(c.table_ids, 1), 0) > 0 THEN c.table_ids
        ELSE COALESCE((SELECT array_agg(ct.table_id) FROM chunk_tables ct WHERE ct.chunk_id = c.id), '{}')
    END
FROM documents d
WHERE d.id = c.doc_id;

ALTER TABLE chunks
    ALTER COLUMN tenant_id SET NOT NULL;
