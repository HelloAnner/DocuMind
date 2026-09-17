CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE conversation_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    title TEXT NOT NULL,
    kb_ids UUID[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'answering', 'completed', 'failed', 'cancelled')),
    parent_message_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
    retry_of_message_id UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
    client_request_id TEXT,
    confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
    no_answer_reason TEXT,
    error_code TEXT,
    error_message TEXT,
    agent_mode TEXT,
    prompt_versions JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_conversation_messages_client_request
    ON conversation_messages(tenant_id, user_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

CREATE TABLE conversation_query_traces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    original_query TEXT NOT NULL,
    rewritten_query TEXT,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    hypothetical_answer TEXT,
    resolved_refs JSONB NOT NULL DEFAULT '[]',
    effective_kb_ids UUID[] NOT NULL DEFAULT '{}',
    rewrite_model TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_retrieval_traces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL,
    doc_id UUID NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('dense', 'bm25', 'rrf', 'rerank')),
    rank INTEGER NOT NULL,
    score DOUBLE PRECISION NOT NULL,
    heading_path JSONB NOT NULL DEFAULT '[]',
    page_range INTEGER[] NOT NULL DEFAULT '{}',
    content_preview TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_citations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    assistant_message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    index INTEGER NOT NULL,
    chunk_id UUID NOT NULL,
    doc_id UUID NOT NULL,
    doc_title TEXT NOT NULL,
    page_range INTEGER[] NOT NULL DEFAULT '{}',
    heading_path JSONB NOT NULL DEFAULT '[]',
    quote TEXT NOT NULL,
    score DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_agent_traces (
    assistant_message_id UUID PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
    trace JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE conversation_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    assistant_message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    reason TEXT CHECK (reason IN ('helpful', 'wrong_answer', 'missing_source', 'outdated', 'not_helpful', 'other')),
    comment TEXT,
    correction TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversation_sessions_user
    ON conversation_sessions (tenant_id, user_id, updated_at DESC);

CREATE INDEX idx_conversation_messages_session
    ON conversation_messages (conversation_id, created_at ASC);

CREATE INDEX idx_conversation_citations_message
    ON conversation_citations (assistant_message_id, index ASC);

CREATE INDEX idx_conversation_feedback_message
    ON conversation_feedback (assistant_message_id);

CREATE INDEX idx_conversation_query_traces_message
    ON conversation_query_traces (message_id);

CREATE INDEX idx_conversation_retrieval_traces_message
    ON conversation_retrieval_traces (message_id);
