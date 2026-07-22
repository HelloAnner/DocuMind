ALTER TABLE chunks
    DROP CONSTRAINT fk_chunks_tenant_document,
    ADD CONSTRAINT fk_chunks_tenant_document
        FOREIGN KEY (tenant_id, kb_id, doc_id)
        REFERENCES documents (tenant_id, kb_id, id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE chunk_embeddings
    DROP CONSTRAINT fk_embeddings_tenant_chunk,
    ADD CONSTRAINT fk_embeddings_tenant_chunk
        FOREIGN KEY (tenant_id, kb_id, doc_id, chunk_id)
        REFERENCES chunks (tenant_id, kb_id, doc_id, id)
        ON DELETE CASCADE
        DEFERRABLE INITIALLY IMMEDIATE;
