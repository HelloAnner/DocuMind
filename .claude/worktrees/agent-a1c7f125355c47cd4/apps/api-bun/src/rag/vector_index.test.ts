// 移植自 apps/api-rs/src/rag/vector_index.rs 的 #[cfg(test)] 用例
import { describe, expect, test } from 'bun:test';
import { documentKbUpdateBody } from './vector_index.ts';

describe('documentKbUpdateBody', () => {
  test('document_kb_update_is_scoped_to_tenant_and_document', () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const docId = '22222222-2222-2222-2222-222222222222';
    const kbId = '33333333-3333-3333-3333-333333333333';
    const body = documentKbUpdateBody(tenantId, docId, kbId);

    const filter = (body.query as Record<string, unknown>).bool as Record<string, unknown>;
    const terms = filter.filter as Array<Record<string, unknown>>;
    expect((terms[0] as Record<string, unknown>).term).toEqual({ tenant_id: tenantId });
    expect((terms[1] as Record<string, unknown>).term).toEqual({ doc_id: docId });
    const script = body.script as Record<string, unknown>;
    expect(script.params).toEqual({ kb_id: kbId });
  });
});
