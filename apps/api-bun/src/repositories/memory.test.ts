// 移植自 apps/api-rs/src/repositories/memory.rs 的 #[cfg(test)] 用例
import { describe, expect, test } from 'bun:test';
import type { Citation, CitationAnchor } from '../models/citation.ts';
import type { ConversationSession } from '../models/conversation.ts';
import type { Feedback } from '../models/feedback.ts';
import type { ConversationMessage } from '../models/message.ts';
import type { RetrievalTrace } from '../models/trace.ts';
import type { MessageRole } from '../models/index.ts';
import { newUuid } from '../infra/uuid.ts';
import { nowRfc3339 } from '../infra/time.ts';
import { InMemoryConversationRepository } from './memory.ts';

function makeSession(overrides: Partial<ConversationSession>): ConversationSession {
  return {
    id: newUuid(), tenant_id: newUuid(), user_id: newUuid(),
    title: '测试会话', kb_ids: [newUuid()], status: 'active', summary: null,
    created_at: nowRfc3339(), updated_at: nowRfc3339(),
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: newUuid(), conversation_id: newUuid(), tenant_id: newUuid(), user_id: newUuid(),
    role: 'user', content: 'hello', status: 'completed',
    parent_message_id: null, retry_of_message_id: null, client_request_id: null,
    confidence: null, no_answer_reason: null, error_code: null, error_message: null,
    agent_mode: null, prompt_versions: null,
    answer_source: 'rag', correction_id: null, correction_version_id: null,
    correction_match_type: null, correction_match_score: null,
    created_at: nowRfc3339(), completed_at: nowRfc3339(),
    ...overrides,
  };
}

function testMessage(
  id: string, conversationId: string, tenantId: string, userId: string, role: MessageRole,
): ConversationMessage {
  return makeMessage({
    id, conversation_id: conversationId, tenant_id: tenantId, user_id: userId,
    role, content: '测试消息',
  });
}

function testRetrieval(messageId: string, docId: string, page: number, contentPreview: string): RetrievalTrace {
  return {
    id: newUuid(), message_id: messageId, chunk_id: newUuid(), doc_id: docId,
    source: 'rerank', rank: page, score: 0.9,
    heading_path: [], page_range: [page], content_preview: contentPreview,
  };
}

describe('InMemoryConversationRepository', () => {
  test('test_session_and_message_crud', async () => {
    const repo = new InMemoryConversationRepository();
    const tenant = newUuid();
    const user = newUuid();
    const session = makeSession({ tenant_id: tenant, user_id: user });
    await repo.createSession(session);
    const fetched = await repo.getSession(tenant, session.id);
    expect(fetched).not.toBeNull();

    const msg = makeMessage({
      conversation_id: session.id, tenant_id: tenant, user_id: user,
      client_request_id: 'req-1',
    });
    await repo.createMessage(msg);
    const dup = await repo.findMessageByClientRequestId(tenant, user, 'req-1');
    expect(dup?.id).toBe(msg.id);
  });

  test('manual_title_prevents_later_automatic_updates', async () => {
    const repo = new InMemoryConversationRepository();
    const tenant = newUuid();
    const user = newUuid();
    const session = makeSession({ tenant_id: tenant, user_id: user, title: '新会话', kb_ids: [] });
    await repo.createSession(session);

    expect(await repo.updateSessionTitle(tenant, user, session.id, '手动标题', true)).toBe(true);
    expect(await repo.updateSessionTitle(tenant, user, session.id, '自动标题', false)).toBe(false);
    const fetched = await repo.getSession(tenant, session.id);
    expect(fetched?.title).toBe('手动标题');
  });

  test('feedback_is_unique_per_message_and_user_and_can_be_removed', async () => {
    const repo = new InMemoryConversationRepository();
    const messageId = newUuid();
    const userId = newUuid();
    const createdAt = nowRfc3339();
    const originalId = newUuid();

    await repo.upsertFeedback({
      id: originalId, assistant_message_id: messageId, user_id: userId,
      rating: 'up', reason: null, comment: null, correction: null,
      created_at: createdAt, updated_at: createdAt, cleared_at: null,
    });

    const updatedAt = nowRfc3339();
    const updated = await repo.upsertFeedback({
      id: newUuid(), assistant_message_id: messageId, user_id: userId,
      rating: 'down', reason: null, comment: '答案不够准确', correction: null,
      created_at: updatedAt, updated_at: updatedAt, cleared_at: null,
    });

    expect(updated.id).toBe(originalId);
    expect(updated.created_at).toBe(createdAt);
    expect(updated.rating).toBe('down');
    expect(updated.comment).toBe('答案不够准确');
    expect((await repo.getFeedback(messageId, userId))?.id).toBe(originalId);
    expect(await repo.deleteFeedback(messageId, userId)).toBe(true);
    expect(await repo.getFeedback(messageId, userId)).toBeNull();
    expect(await repo.deleteFeedback(messageId, userId)).toBe(false);
  });

  test('lists_only_uniquely_cited_documents', async () => {
    const repo = new InMemoryConversationRepository();
    const tenantId = newUuid();
    const userId = newUuid();
    const conversationId = newUuid();
    const kbId = newUuid();
    const userMessageId = newUuid();
    const assistantMessageId = newUuid();
    const citedDocId = newUuid();
    const retrievedDocId = newUuid();

    await repo.createSession(makeSession({
      id: conversationId, tenant_id: tenantId, user_id: userId,
      title: '文件聚合测试', kb_ids: [kbId],
    }));
    await repo.createMessage(testMessage(userMessageId, conversationId, tenantId, userId, 'user'));
    await repo.createMessage(
      testMessage(assistantMessageId, conversationId, tenantId, userId, 'assistant'),
    );

    await repo.saveRetrievalTraces([
      testRetrieval(userMessageId, citedDocId, 1, '检索片段'),
      testRetrieval(userMessageId, citedDocId, 2, '重排片段'),
      testRetrieval(userMessageId, retrievedDocId, 3, '另一份相关文件'),
    ]);

    const anchor: CitationAnchor = {
      anchor_id: null, parse_job_id: null, format: 'pdf', kind: '',
      page: 8, slide: null, block_ids: [], table_ids: [],
      char_range: null, bbox: null, location_status: 'page_only',
    };
    const citation: Citation = {
      id: newUuid(), assistant_message_id: assistantMessageId, index: 1,
      chunk_id: newUuid(), doc_id: citedDocId,
      doc_title: '采购合同.pdf', page_range: [8], heading_path: [],
      quote: '验收后支付尾款', score: 0.95, source_status: 'available',
      anchor,
    };
    await repo.saveCitations([citation]);

    const files = await repo.listConversationFiles(tenantId, conversationId, [kbId]);
    expect(files.length).toBe(1);

    const cited = files[0]!;
    expect(cited.doc_id).toBe(citedDocId);
    expect(cited.retrieval_count).toBe(0);
    expect(cited.citation_count).toBe(1);
    expect(cited.doc_title).toBe('采购合同.pdf');
    expect(cited.preview_page_range).toEqual([8]);
    expect(cited.preview_quote).toBe('验收后支付尾款');
  });
});
