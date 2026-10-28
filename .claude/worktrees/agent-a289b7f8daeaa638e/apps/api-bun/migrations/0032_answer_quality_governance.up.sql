ALTER TABLE conversation_feedback ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;

ALTER TABLE conversation_messages
    ADD COLUMN IF NOT EXISTS answer_source TEXT NOT NULL DEFAULT 'rag',
    ADD COLUMN IF NOT EXISTS correction_id UUID,
    ADD COLUMN IF NOT EXISTS correction_version_id UUID,
    ADD COLUMN IF NOT EXISTS correction_match_type TEXT,
    ADD COLUMN IF NOT EXISTS correction_match_score DOUBLE PRECISION;
ALTER TABLE conversation_messages
    ADD CONSTRAINT conversation_messages_answer_source_check CHECK (answer_source IN ('rag', 'manual_correction')),
    ADD CONSTRAINT conversation_messages_correction_match_type_check CHECK (correction_match_type IS NULL OR correction_match_type IN ('exact', 'alias', 'semantic'));

CREATE TABLE answer_quality_cases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    canonical_question TEXT NOT NULL,
    question_fingerprint TEXT NOT NULL,
    kb_ids UUID[] NOT NULL DEFAULT '{}',
    kb_scope_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
    suggested_cause TEXT,
    root_cause TEXT,
    diagnostic_snapshot JSONB NOT NULL DEFAULT '{}',
    resolution_note TEXT,
    correction_id UUID,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, question_fingerprint, kb_scope_hash)
);

CREATE TABLE answer_quality_case_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id UUID NOT NULL REFERENCES answer_quality_cases(id) ON DELETE CASCADE,
    feedback_id UUID UNIQUE REFERENCES conversation_feedback(id) ON DELETE SET NULL,
    assistant_message_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
    user_id UUID,
    question_snapshot TEXT NOT NULL,
    answer_snapshot TEXT NOT NULL,
    reason TEXT,
    comment TEXT,
    suggested_correction TEXT,
    kb_ids UUID[] NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE answer_corrections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    source_case_id UUID REFERENCES answer_quality_cases(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'needs_review', 'archived')),
    required_kb_ids UUID[] NOT NULL DEFAULT '{}',
    published_version_id UUID,
    draft_version_id UUID,
    index_status TEXT NOT NULL DEFAULT 'pending' CHECK (index_status IN ('pending', 'indexed', 'failed')),
    published_by UUID,
    published_at TIMESTAMPTZ,
    valid_until TIMESTAMPTZ,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE answer_correction_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    correction_id UUID NOT NULL REFERENCES answer_corrections(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    canonical_question TEXT NOT NULL,
    answer_markdown TEXT NOT NULL,
    change_note TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (correction_id, version)
);

CREATE TABLE answer_correction_aliases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    correction_id UUID NOT NULL REFERENCES answer_corrections(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES answer_correction_versions(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE answer_correction_sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_id UUID NOT NULL REFERENCES answer_correction_versions(id) ON DELETE CASCADE,
    kb_id UUID,
    doc_id UUID,
    chunk_id UUID,
    parse_job_id UUID,
    source_title TEXT NOT NULL DEFAULT '租户标准答案',
    quote TEXT NOT NULL DEFAULT '',
    page_range INTEGER[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE answer_corrections
    ADD CONSTRAINT answer_corrections_published_version_fk FOREIGN KEY (published_version_id) REFERENCES answer_correction_versions(id) ON DELETE SET NULL,
    ADD CONSTRAINT answer_corrections_draft_version_fk FOREIGN KEY (draft_version_id) REFERENCES answer_correction_versions(id) ON DELETE SET NULL;
ALTER TABLE answer_quality_cases
    ADD CONSTRAINT answer_quality_cases_correction_fk FOREIGN KEY (correction_id) REFERENCES answer_corrections(id) ON DELETE SET NULL;
ALTER TABLE conversation_messages
    ADD CONSTRAINT conversation_messages_correction_fk FOREIGN KEY (correction_id) REFERENCES answer_corrections(id) ON DELETE SET NULL,
    ADD CONSTRAINT conversation_messages_correction_version_fk FOREIGN KEY (correction_version_id) REFERENCES answer_correction_versions(id) ON DELETE SET NULL;

CREATE INDEX idx_conversation_feedback_active_down ON conversation_feedback (rating, updated_at DESC) WHERE rating = 'down' AND cleared_at IS NULL;
CREATE INDEX idx_answer_quality_cases_tenant_status ON answer_quality_cases (tenant_id, status, last_seen_at DESC);
CREATE INDEX idx_answer_quality_case_items_case_active ON answer_quality_case_items (case_id, active, updated_at DESC);
CREATE INDEX idx_answer_corrections_tenant_status ON answer_corrections (tenant_id, status, updated_at DESC);
CREATE INDEX idx_answer_correction_aliases_lookup ON answer_correction_aliases (tenant_id, normalized_text) WHERE active = TRUE;
CREATE UNIQUE INDEX idx_answer_correction_aliases_active_unique ON answer_correction_aliases (tenant_id, normalized_text) WHERE active = TRUE;
CREATE INDEX idx_answer_correction_sources_version ON answer_correction_sources (version_id);
