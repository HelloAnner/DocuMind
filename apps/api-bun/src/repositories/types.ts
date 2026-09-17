// 移植自 apps/api-rs/src/repositories/trait_repo.rs 的端口定义
import type { AgentTrace } from '../models/agent.ts';
import type { Citation } from '../models/citation.ts';
import type { ConversationFile } from '../models/conversation_file.ts';
import type { ConversationListResponse, ConversationSession } from '../models/conversation.ts';
import type { Feedback } from '../models/feedback.ts';
import type { ConversationMessage } from '../models/message.ts';
import type { QueryTrace, RetrievalTrace } from '../models/trace.ts';

export interface ConversationRepository {
  listConversationFiles(
    tenantId: string, conversationId: string, allowedKbIds: string[],
  ): Promise<ConversationFile[]>;

  createSession(session: ConversationSession): Promise<void>;
  listSessions(
    tenantId: string, userId: string, limit: number, cursor: string | null,
  ): Promise<ConversationListResponse>;
  getSession(tenantId: string, conversationId: string): Promise<ConversationSession | null>;
  updateSession(session: ConversationSession): Promise<void>;
  updateSessionTitle(
    tenantId: string, userId: string, conversationId: string, title: string, manual: boolean,
  ): Promise<boolean>;

  createMessage(message: ConversationMessage): Promise<void>;
  getMessage(tenantId: string, messageId: string): Promise<ConversationMessage | null>;
  getMessages(tenantId: string, conversationId: string): Promise<ConversationMessage[]>;
  updateMessage(message: ConversationMessage): Promise<void>;
  findMessageByClientRequestId(
    tenantId: string, userId: string, clientRequestId: string,
  ): Promise<ConversationMessage | null>;

  saveQueryTrace(trace: QueryTrace): Promise<void>;
  getQueryTrace(messageId: string): Promise<QueryTrace | null>;

  saveRetrievalTraces(traces: RetrievalTrace[]): Promise<void>;
  getRetrievalTraces(messageId: string): Promise<RetrievalTrace[]>;

  saveCitations(citations: Citation[]): Promise<void>;
  getCitations(assistantMessageId: string): Promise<Citation[]>;
  saveAgentTrace(assistantMessageId: string, trace: AgentTrace): Promise<void>;
  getAgentTrace(assistantMessageId: string): Promise<AgentTrace | null>;

  upsertFeedback(feedback: Feedback): Promise<Feedback>;
  getFeedback(assistantMessageId: string, userId: string): Promise<Feedback | null>;
  deleteFeedback(assistantMessageId: string, userId: string): Promise<boolean>;
}

