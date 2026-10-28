CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'docx', 'pptx', 'txt', 'md')),
    file_size_bytes BIGINT NOT NULL DEFAULT 0,
    storage_key TEXT,
    file_sha256 TEXT,
    parse_status TEXT NOT NULL DEFAULT 'uploaded',
    parse_version INT NOT NULL DEFAULT 0,
    latest_parse_job_id UUID,
    chunk_count INT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE document_parse_jobs (
    parse_job_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parser_version TEXT NOT NULL,
    parser_config JSONB NOT NULL DEFAULT '{}',
    parse_identity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_code TEXT,
    error_message TEXT,
    quality_score DOUBLE PRECISION,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (doc_id, parse_identity)
);

ALTER TABLE documents
    ADD CONSTRAINT fk_documents_latest_parse_job
    FOREIGN KEY (latest_parse_job_id)
    REFERENCES document_parse_jobs(parse_job_id)
    ON DELETE SET NULL;

CREATE TABLE document_blocks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    block_index INT NOT NULL,
    block_type TEXT NOT NULL,
    heading_path TEXT[] NOT NULL DEFAULT '{}',
    page_range INT[] NOT NULL DEFAULT '{}',
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (parse_job_id, block_index)
);

CREATE TABLE document_parse_results (
    parse_job_id UUID PRIMARY KEY REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parsed_json JSONB NOT NULL,
    parsed_json_object_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE document_tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    table_index INT NOT NULL,
    heading_path TEXT[] NOT NULL DEFAULT '{}',
    page_range INT[] NOT NULL DEFAULT '{}',
    markdown TEXT NOT NULL,
    cells JSONB NOT NULL DEFAULT '[]',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (parse_job_id, table_index)
);

CREATE TABLE document_table_cells (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES document_tables(id) ON DELETE CASCADE,
    row_index INT NOT NULL,
    col_index INT NOT NULL,
    row_span INT NOT NULL DEFAULT 1,
    col_span INT NOT NULL DEFAULT 1,
    text TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(table_id, row_index, col_index)
);

CREATE TABLE chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parse_job_id UUID NOT NULL REFERENCES document_parse_jobs(parse_job_id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    heading_path TEXT[] NOT NULL DEFAULT '{}',
    page_range INT[] NOT NULL DEFAULT '{}',
    token_count INT NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (parse_job_id, chunk_index)
);

CREATE TABLE chunk_embeddings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    kb_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
    doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    embedding_model TEXT NOT NULL,
    embedding_dim INT NOT NULL,
    embedding_vector JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    error_message TEXT,
    embedded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(chunk_id, embedding_model)
);

CREATE INDEX idx_documents_tenant_kb_status
    ON documents(tenant_id, kb_id, parse_status);
CREATE INDEX idx_document_parse_jobs_doc
    ON document_parse_jobs(doc_id, created_at DESC);
CREATE INDEX idx_document_blocks_doc
    ON document_blocks(doc_id, parse_job_id, block_index);
CREATE INDEX idx_document_parse_results_doc
    ON document_parse_results(doc_id);
CREATE INDEX idx_document_tables_doc
    ON document_tables(doc_id, parse_job_id, table_index);
CREATE INDEX idx_document_table_cells_table_pos
    ON document_table_cells(table_id, row_index, col_index);
CREATE INDEX idx_chunks_scope
    ON chunks(tenant_id, kb_id, doc_id, chunk_index);
CREATE INDEX idx_chunks_content_prefix
    ON chunks USING gin (to_tsvector('simple', content));
CREATE INDEX idx_chunk_embeddings_scope
    ON chunk_embeddings(tenant_id, kb_id, embedding_model, status);

-- Development seed data keeps first deployment immediately testable while the
-- parser/upload pipeline is being completed.
INSERT INTO documents (
    id, tenant_id, kb_id, title, file_type, file_size_bytes, storage_key,
    file_sha256, parse_status, parse_version, chunk_count, created_by
)
VALUES
    (
        '00000000-0000-0000-0000-000000000101'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000011'::uuid,
        '2025年Q3采购合同.docx',
        'docx',
        876544,
        'seed/contracts/2025-q3-procurement.docx',
        'seed-docx-q3-procurement',
        'indexed',
        1,
        3,
        '00000000-0000-0000-0000-000000000002'::uuid
    ),
    (
        '00000000-0000-0000-0000-000000000102'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000010'::uuid,
        '2025年度销售策略.pptx',
        'pptx',
        2516582,
        'seed/sales/2025-sales-strategy.pptx',
        'seed-pptx-2025-sales',
        'indexed',
        1,
        3,
        '00000000-0000-0000-0000-000000000002'::uuid
    ),
    (
        '00000000-0000-0000-0000-000000000103'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000012'::uuid,
        '员工报销制度.pdf',
        'pdf',
        1258291,
        'seed/hr/expense-policy.pdf',
        'seed-pdf-expense-policy',
        'indexed',
        1,
        3,
        '00000000-0000-0000-0000-000000000002'::uuid
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO document_parse_jobs (
    parse_job_id, tenant_id, kb_id, doc_id, parser_version, parser_config,
    parse_identity, status, quality_score, started_at, completed_at
)
VALUES
    (
        '00000000-0000-0000-0000-000000000201'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000011'::uuid,
        '00000000-0000-0000-0000-000000000101'::uuid,
        'documind-parser@seed',
        '{"source":"seed"}',
        'seed-docx-q3-procurement-documind-parser-seed',
        'completed',
        0.96,
        NOW(),
        NOW()
    ),
    (
        '00000000-0000-0000-0000-000000000202'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000010'::uuid,
        '00000000-0000-0000-0000-000000000102'::uuid,
        'documind-parser@seed',
        '{"source":"seed"}',
        'seed-pptx-2025-sales-documind-parser-seed',
        'completed',
        0.94,
        NOW(),
        NOW()
    ),
    (
        '00000000-0000-0000-0000-000000000203'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000012'::uuid,
        '00000000-0000-0000-0000-000000000103'::uuid,
        'documind-parser@seed',
        '{"source":"seed"}',
        'seed-pdf-expense-policy-documind-parser-seed',
        'completed',
        0.93,
        NOW(),
        NOW()
    )
ON CONFLICT (parse_job_id) DO NOTHING;

UPDATE documents
SET latest_parse_job_id = '00000000-0000-0000-0000-000000000201'::uuid
WHERE id = '00000000-0000-0000-0000-000000000101'::uuid;
UPDATE documents
SET latest_parse_job_id = '00000000-0000-0000-0000-000000000202'::uuid
WHERE id = '00000000-0000-0000-0000-000000000102'::uuid;
UPDATE documents
SET latest_parse_job_id = '00000000-0000-0000-0000-000000000203'::uuid
WHERE id = '00000000-0000-0000-0000-000000000103'::uuid;

INSERT INTO document_parse_results (parse_job_id, doc_id, parsed_json)
VALUES
    (
        '00000000-0000-0000-0000-000000000201'::uuid,
        '00000000-0000-0000-0000-000000000101'::uuid,
        '{"source":"seed","block_count":3,"table_count":0}'::jsonb
    ),
    (
        '00000000-0000-0000-0000-000000000202'::uuid,
        '00000000-0000-0000-0000-000000000102'::uuid,
        '{"source":"seed","block_count":3,"table_count":0}'::jsonb
    ),
    (
        '00000000-0000-0000-0000-000000000203'::uuid,
        '00000000-0000-0000-0000-000000000103'::uuid,
        '{"source":"seed","block_count":3,"table_count":0}'::jsonb
    )
ON CONFLICT (parse_job_id) DO NOTHING;

INSERT INTO chunks (
    id, tenant_id, kb_id, doc_id, parse_job_id, chunk_index,
    content, heading_path, page_range, token_count, metadata
)
VALUES
    (
        '00000000-0000-0000-0000-000000000301'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000011'::uuid,
        '00000000-0000-0000-0000-000000000101'::uuid,
        '00000000-0000-0000-0000-000000000201'::uuid,
        1,
        '付款节点：合同签署后支付首付款30%，验收通过后支付60%，质保期结束支付10%。付款申请必须附验收单和发票。',
        ARRAY['付款条款'],
        ARRAY[5],
        58,
        '{"block_type":"paragraph"}'
    ),
    (
        '00000000-0000-0000-0000-000000000302'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000011'::uuid,
        '00000000-0000-0000-0000-000000000101'::uuid,
        '00000000-0000-0000-0000-000000000201'::uuid,
        2,
        '任何一方未按约定履行合同义务的，应当向对方支付合同金额10%的违约金；逾期超过30日的，对方有权解除合同。',
        ARRAY['违约责任'],
        ARRAY[7],
        61,
        '{"block_type":"paragraph"}'
    ),
    (
        '00000000-0000-0000-0000-000000000303'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000011'::uuid,
        '00000000-0000-0000-0000-000000000101'::uuid,
        '00000000-0000-0000-0000-000000000201'::uuid,
        3,
        '交付范围包括软件授权、部署服务、管理员培训和上线验收支持。最终验收以双方签署的验收报告为准。',
        ARRAY['交付与验收'],
        ARRAY[3],
        54,
        '{"block_type":"paragraph"}'
    ),
    (
        '00000000-0000-0000-0000-000000000304'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000010'::uuid,
        '00000000-0000-0000-0000-000000000102'::uuid,
        '00000000-0000-0000-0000-000000000202'::uuid,
        1,
        'Q3华东区域销售目标为1200万元，较去年同期增长15%，其中新客户占比不低于30%。重点行业为制造、零售和企业服务。',
        ARRAY['Q3目标', '分地区策略'],
        ARRAY[3,4],
        66,
        '{"block_type":"slide_text","slide":3}'
    ),
    (
        '00000000-0000-0000-0000-000000000305'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000010'::uuid,
        '00000000-0000-0000-0000-000000000102'::uuid,
        '00000000-0000-0000-0000-000000000202'::uuid,
        2,
        '销售策略要求优先推进存量客户扩容，针对高价值客户建立季度复盘机制，并由解决方案团队提供行业化演示材料。',
        ARRAY['销售动作', '客户经营'],
        ARRAY[7],
        55,
        '{"block_type":"slide_text","slide":7}'
    ),
    (
        '00000000-0000-0000-0000-000000000306'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000010'::uuid,
        '00000000-0000-0000-0000-000000000102'::uuid,
        '00000000-0000-0000-0000-000000000202'::uuid,
        3,
        '渠道政策在Q3保持价格底线不变，重点奖励联合线索、联合拜访和成交复盘，单个项目返点需经过区域负责人审批。',
        ARRAY['渠道政策'],
        ARRAY[9],
        54,
        '{"block_type":"slide_text","slide":9}'
    ),
    (
        '00000000-0000-0000-0000-000000000307'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000012'::uuid,
        '00000000-0000-0000-0000-000000000103'::uuid,
        '00000000-0000-0000-0000-000000000203'::uuid,
        1,
        '员工报销需提交发票原件、费用明细、审批单，并在费用发生后30个工作日内提交；逾期提交需部门负责人补充说明。',
        ARRAY['报销流程'],
        ARRAY[2],
        62,
        '{"block_type":"paragraph"}'
    ),
    (
        '00000000-0000-0000-0000-000000000308'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000012'::uuid,
        '00000000-0000-0000-0000-000000000103'::uuid,
        '00000000-0000-0000-0000-000000000203'::uuid,
        2,
        '差旅住宿标准按城市级别执行，一线城市每晚不超过650元，其他城市每晚不超过450元，超标部分原则上由个人承担。',
        ARRAY['差旅标准'],
        ARRAY[4],
        58,
        '{"block_type":"paragraph"}'
    ),
    (
        '00000000-0000-0000-0000-000000000309'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000012'::uuid,
        '00000000-0000-0000-0000-000000000103'::uuid,
        '00000000-0000-0000-0000-000000000203'::uuid,
        3,
        '招待费报销必须注明客户名称、参与人员、业务目的和审批编号，单次超过3000元需提前完成专项审批。',
        ARRAY['招待费'],
        ARRAY[6],
        52,
        '{"block_type":"paragraph"}'
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO chunk_embeddings (
    tenant_id, kb_id, doc_id, chunk_id, embedding_model, embedding_dim,
    embedding_vector, content_hash, status, embedded_at
)
SELECT tenant_id, kb_id, doc_id, id,
       'local-hash-embedding-v1',
       64,
       '[0.0]'::jsonb,
       md5(content),
       'completed',
       NOW()
FROM chunks
WHERE id IN (
    '00000000-0000-0000-0000-000000000301'::uuid,
    '00000000-0000-0000-0000-000000000302'::uuid,
    '00000000-0000-0000-0000-000000000303'::uuid,
    '00000000-0000-0000-0000-000000000304'::uuid,
    '00000000-0000-0000-0000-000000000305'::uuid,
    '00000000-0000-0000-0000-000000000306'::uuid,
    '00000000-0000-0000-0000-000000000307'::uuid,
    '00000000-0000-0000-0000-000000000308'::uuid,
    '00000000-0000-0000-0000-000000000309'::uuid
)
ON CONFLICT (chunk_id, embedding_model) DO NOTHING;

INSERT INTO document_blocks (
    tenant_id, kb_id, doc_id, parse_job_id, block_index,
    block_type, heading_path, page_range, content, metadata
)
SELECT tenant_id, kb_id, doc_id, parse_job_id, chunk_index,
       COALESCE(metadata->>'block_type', 'paragraph'), heading_path, page_range, content, metadata
FROM chunks
WHERE parse_job_id IN (
    '00000000-0000-0000-0000-000000000201'::uuid,
    '00000000-0000-0000-0000-000000000202'::uuid,
    '00000000-0000-0000-0000-000000000203'::uuid
)
ON CONFLICT (parse_job_id, block_index) DO NOTHING;
