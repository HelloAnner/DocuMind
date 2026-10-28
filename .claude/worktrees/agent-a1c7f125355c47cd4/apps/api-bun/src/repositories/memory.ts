// 移植自 apps/api-rs/src/repositories/memory.rs
import type { AgentTrace } from '../models/agent.ts';
import type { Citation } from '../models/citation.ts';
import type { ConversationListItem, ConversationListResponse, ConversationSession } from '../models/conversation.ts';
import type { ConversationFile } from '../models/conversation_file.ts';
import type { Feedback } from '../models/feedback.ts';
import type { ConversationMessage } from '../models/message.ts';
import type { QueryTrace, RetrievalTrace } from '../models/trace.ts';
import type { UserFile } from '../models/user_file.ts';
import { nowRfc3339 } from '../infra/time.ts';
import type { ConversationRepository } from './types.ts';
import { FileAccumulator } from './conversation_files.ts';

function timeMs(value: string): number {
  return Date.parse(value);
}

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly sessions = new Map<string, ConversationSession>();
  private readonly titleLocks = new Set<string>();
  private messages = new Map<string, ConversationMessage>();
  private clientRequestIds = new Map<string, string>();
  private readonly queryTraces = new Map<string, QueryTrace>();
  private readonly retrievalTraces = new Map<string, RetrievalTrace[]>();
  private readonly citations = new Map<string, Citation[]>();
  private readonly agentTraces = new Map<string, AgentTrace>();
  private readonly feedback = new Map<string, Feedback>();

  private static clientRequestKey(tenantId: string, userId: string, clientRequestId: string): string {
    return tenantId + '\u0000' + userId + '\u0000' + clientRequestId;
  }

  private static feedbackKey(assistantMessageId: string, userId: string): string {
    return assistantMessageId + '\u0000' + userId;
  }

  async createSession(session: ConversationSession): Promise<void> {
    if (session.title.trim() !== '新会话') {
      this.titleLocks.add(session.id);
    }
    this.sessions.set(session.id, session);
  }

  async listSessions(
    tenantId: string, userId: string, limit: number, cursor: string | null,
  ): Promise<ConversationListResponse> {
    const offset = cursor !== null && /^\d+$/.test(cursor) ? parseInt(cursor, 10) : 0;

    const list = [...this.sessions.values()]
      .filter((s) => s.tenant_id === tenantId && s.user_id === userId && s.status === 'active')
      .sort((a, b) => timeMs(b.updated_at) - timeMs(a.updated_at));

    const page: ConversationListItem[] = list
      .slice(offset, offset + limit + 1)
      .map((s) => {
        let preview: string | null = null;
        let previewAt = -Infinity;
        for (const m of this.messages.values()) {
          if (m.conversation_id !== s.id || m.role !== 'user' || m.status !== 'completed') continue;
          const at = timeMs(m.created_at);
          if (at >= previewAt) {
            previewAt = at;
            preview = m.content;
          }
        }
        return {
          conversation_id: s.id,
          title: s.title,
          kb_ids: [...s.kb_ids],
          last_message_preview: preview,
          updated_at: s.updated_at,
        };
      });

    const hasMore = page.length > limit;
    const items = page.slice(0, limit);
    const nextCursor = hasMore ? String(offset + limit) : null;
    return { items, next_cursor: nextCursor };
  }

  async getSession(tenantId: string, conversationId: string): Promise<ConversationSession | null> {
    const session = this.sessions.get(conversationId);
    if (session === undefined || session.tenant_id !== tenantId) return null;
    return session;
  }

  async updateSession(session: ConversationSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async updateSessionTitle(
    tenantId: string, userId: string, conversationId: string, title: string, manual: boolean,
  ): Promise<boolean> {
    if (!manual && this.titleLocks.has(conversationId)) {
      return false;
    }
    const session = this.sessions.get(conversationId);
    if (session === undefined) return false;
    if (session.tenant_id !== tenantId || session.user_id !== userId || session.status !== 'active') {
      return false;
    }
    session.title = title;
    session.updated_at = nowRfc3339();
    if (manual) {
      this.titleLocks.add(conversationId);
    }
    return true;
  }

  async createMessage(message: ConversationMessage): Promise<void> {
    if (message.client_request_id !== null) {
      this.clientRequestIds.set(
        InMemoryConversationRepository.clientRequestKey(
          message.tenant_id, message.user_id, message.client_request_id,
        ),
        message.id,
      );
    }
    this.messages.set(message.id, message);
  }

  async createMessagePair(
    userMessage: ConversationMessage,
    assistantMessage: ConversationMessage,
    fileIds: string[],
  ): Promise<void> {
    if (fileIds.length > 0) {
      throw new Error('in-memory repository does not store user files');
    }
    if (this.messages.has(userMessage.id) || this.messages.has(assistantMessage.id)) {
      throw new Error('message already exists');
    }
    const messages = new Map(this.messages);
    const clientRequestIds = new Map(this.clientRequestIds);
    for (const message of [userMessage, assistantMessage]) {
      messages.set(message.id, message);
      if (message.client_request_id !== null) {
        const key = InMemoryConversationRepository.clientRequestKey(
          message.tenant_id, message.user_id, message.client_request_id,
        );
        if (clientRequestIds.has(key)) throw new Error('client request id already exists');
        clientRequestIds.set(key, message.id);
      }
    }
    this.messages = messages;
    this.clientRequestIds = clientRequestIds;
  }

  async getMessage(tenantId: string, messageId: string): Promise<ConversationMessage | null> {
    const message = this.messages.get(messageId);
    if (message === undefined || message.tenant_id !== tenantId) return null;
    return message;
  }

  async getMessages(tenantId: string, conversationId: string): Promise<ConversationMessage[]> {
    return [...this.messages.values()]
      .filter((m) => m.conversation_id === conversationId && m.tenant_id === tenantId)
      .sort((a, b) => timeMs(a.created_at) - timeMs(b.created_at));
  }

  async updateMessage(message: ConversationMessage): Promise<void> {
    this.messages.set(message.id, message);
  }

  async findMessageByClientRequestId(
    tenantId: string, userId: string, clientRequestId: string,
  ): Promise<ConversationMessage | null> {
    const id = this.clientRequestIds.get(
      InMemoryConversationRepository.clientRequestKey(tenantId, userId, clientRequestId),
    );
    if (id === undefined) return null;
    return this.getMessage(tenantId, id);
  }

  async getMessageFiles(
    _tenantId: string, _userId: string, _messageId: string,
  ): Promise<UserFile[]> {
    return [];
  }

  async saveQueryTrace(trace: QueryTrace): Promise<void> {
    this.queryTraces.set(trace.message_id, trace);
  }

  async getQueryTrace(messageId: string): Promise<QueryTrace | null> {
    return this.queryTraces.get(messageId) ?? null;
  }

  async saveRetrievalTraces(traces: RetrievalTrace[]): Promise<void> {
    const first = traces[0];
    if (first !== undefined) {
      this.retrievalTraces.set(first.message_id, traces);
    }
  }

  async getRetrievalTraces(messageId: string): Promise<RetrievalTrace[]> {
    return this.retrievalTraces.get(messageId) ?? [];
  }

  async saveCitations(citations: Citation[]): Promise<void> {
    const first = citations[0];
    if (first !== undefined) {
      this.citations.set(first.assistant_message_id, citations);
    }
  }

  async getCitations(assistantMessageId: string): Promise<Citation[]> {
    return this.citations.get(assistantMessageId) ?? [];
  }

  async saveAgentTrace(assistantMessageId: string, trace: AgentTrace): Promise<void> {
    this.agentTraces.set(assistantMessageId, trace);
  }

  async getAgentTrace(assistantMessageId: string): Promise<AgentTrace | null> {
    return this.agentTraces.get(assistantMessageId) ?? null;
  }

  async upsertFeedback(feedback: Feedback): Promise<Feedback> {
    const key = InMemoryConversationRepository.feedbackKey(
      feedback.assistant_message_id, feedback.user_id,
    );
    const existing = this.feedback.get(key);
    if (existing !== undefined) {
      feedback.id = existing.id;
      feedback.created_at = existing.created_at;
    }
    feedback.cleared_at = null;
    this.feedback.set(key, { ...feedback });
    return feedback;
  }

  async getFeedback(assistantMessageId: string, userId: string): Promise<Feedback | null> {
    const feedback = this.feedback.get(
      InMemoryConversationRepository.feedbackKey(assistantMessageId, userId),
    );
    return feedback === undefined || feedback.cleared_at !== null ? null : feedback;
  }

  async deleteFeedback(assistantMessageId: string, userId: string): Promise<boolean> {
    const feedback = this.feedback.get(
      InMemoryConversationRepository.feedbackKey(assistantMessageId, userId),
    );
    if (feedback === undefined || feedback.cleared_at !== null) return false;
    feedback.cleared_at = nowRfc3339();
    feedback.updated_at = feedback.cleared_at;
    return true;
  }

  async listConversationFiles(
    tenantId: string, conversationId: string, _allowedKbIds: string[],
  ): Promise<ConversationFile[]> {
    const messages = [...this.messages.values()].filter(
      (message) => message.tenant_id === tenantId && message.conversation_id === conversationId,
    );
    const files = new Map<string, FileAccumulator>();

    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const msgCitations = this.citations.get(message.id);
      if (msgCitations === undefined) continue;
      for (const citation of msgCitations) {
        let entry = files.get(citation.doc_id);
        if (entry === undefined) {
          entry = new FileAccumulator(citation, message);
          files.set(citation.doc_id, entry);
        }
        entry.recordCitation(citation, message);
      }
    }

    return [...files.values()]
      .map((e) => e.file)
      .sort((a, b) =>
        timeMs(b.last_used_at) - timeMs(a.last_used_at)
        || (a.doc_title < b.doc_title ? -1 : a.doc_title > b.doc_title ? 1 : 0),
      );
  }
}
