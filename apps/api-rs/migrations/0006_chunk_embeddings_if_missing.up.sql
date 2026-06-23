CREATE TABLE IF NOT EXISTS chunk_embeddings (
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

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_scope
    ON chunk_embeddings(tenant_id, kb_id, embedding_model, status);
