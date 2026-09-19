// 移植自 apps/api-rs/src/api/conversations.rs 的 HTTP 辅助层（鉴权范围/消息序列化）
import type { Context } from 'hono';
import { AppError } from '../errors.ts';
import { isUuid } from '../infra/uuid.ts';
import type { AppEnv } from '../http/types.ts';
import type { ReactStepTrace } from '../models/agent.ts';
import type { Citation } from '../models/citation.ts';
import type { ConversationSession } from '../models/conversation.ts';
import type { FeedbackResponse } from '../models/feedback.ts';
import { feedbackToResponse } from '../models/feedback.ts';
import type { CurrentActor } from '../models/identity.ts';
import type { ConversationMessage, MessageResponse } from '../models/message.ts';
import { citationToResponse } from '../models/message.ts';
import type { ConversationRepository } from '../repositories/types.ts';
import type { AppState } from '../state.ts';

export function intersectKbIds(left: string[], right: string[]): string[] {
  return left.filter((id) => right.includes(id));
}

export function requestedKbScope(requestedKbIds: string[], allowedKbIds: string[]): string[] {
  const requested = [...new Set(requestedKbIds)];
  if (requested.some((id) => !allowedKbIds.includes(id))) throw AppError.kbScopeDenied();
  return requested.length === 0 ? [...allowedKbIds] : requested;
}

/** 对应 Rust owned_session：必须存在且属于当前用户。 */
export async function ownedSession(
  state: AppState, actor: CurrentActor, conversationId: string,
): Promise<ConversationSession> {
  const session = await state.repository.getSession(actor.tenant_id, conversationId);
  if (session === null || session.user_id !== actor.user_id) {
    throw AppError.conversationNotFound();
  }
  return session;
}

/** 请求范围只能收窄会话创建时保存的知识库范围。 */
export async function resolveConversationScope(
  state: AppState, actor: CurrentActor, conversationId: string, requestedKbIds: string[],
): Promise<{ session: ConversationSession; effectiveKbIds: string[] }> {
  const session = await ownedSession(state, actor, conversationId);
  const configured = session.kb_ids.length === 0 ? actor.allowed_kb_ids : session.kb_ids;
  const sessionScope = intersectKbIds(configured, actor.allowed_kb_ids);
  const requested = [...new Set(requestedKbIds)];
  if (requested.some((id) => !sessionScope.includes(id))) throw AppError.kbScopeDenied();
  return {
    session: session,
    effectiveKbIds: requested.length === 0 ? sessionScope : requested,
  };
}

/** 对应 Rust message_to_response：只有助手消息才带引用/推理步骤/反馈。 */
export async function messageToResponse(
  repo: ConversationRepository, message: ConversationMessage, currentUserId: string,
): Promise<MessageResponse> {
  const isAssistant = message.role === 'assistant';
  const citations = isAssistant ? await repo.getCitations(message.id) : [];
  const reasoningSteps: ReactStepTrace[] = isAssistant
    ? (await repo.getAgentTrace(message.id))?.react_steps ?? []
    : [];
  const feedback = isAssistant
    ? await feedbackResponseFor(repo, message.id, currentUserId)
    : null;
  return {
    message_id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    confidence: message.confidence,
    no_answer_reason: message.no_answer_reason,
    agent_mode: message.agent_mode,
    prompt_versions: message.prompt_versions,
    citations: citations.map((citation: Citation) => citationToResponse(citation)),
    reasoning_steps: reasoningSteps,
    // Rust 侧 feedback 是 skip_serializing_if=Option::is_none：没有反馈时不能出现该键
    feedback: feedback === null ? undefined : feedback,
    answer_source: message.answer_source,
    correction_id: message.correction_id,
    correction_version_id: message.correction_version_id,
    correction_match_type: message.correction_match_type,
    correction_match_score: message.correction_match_score,
    parent_message_id: message.parent_message_id,
    retry_of_message_id: message.retry_of_message_id,
    created_at: message.created_at,
    completed_at: message.completed_at,
  };
}

async function feedbackResponseFor(
  repo: ConversationRepository, messageId: string, userId: string,
): Promise<FeedbackResponse | null> {
  const feedback = await repo.getFeedback(messageId, userId);
  return feedback === null ? null : feedbackToResponse(feedback);
}

/** 对应 Rust validate_feedback_target：会话归属、消息归属、助手角色三重校验。 */
export async function validateFeedbackTarget(
  state: AppState, tenantId: string, userId: string,
  conversationId: string, messageId: string,
): Promise<void> {
  const session = await state.repository.getSession(tenantId, conversationId);
  if (session === null) throw AppError.conversationNotFound();
  const message = await state.repository.getMessage(tenantId, messageId);
  if (message === null) throw AppError.messageNotFound();
  if (session.user_id !== userId
    || message.conversation_id !== session.id
    || message.role !== 'assistant') {
    throw AppError.messageNotFound();
  }
}

/** Path 参数都是 UUID；Rust axum 解析失败会直接 400。 */
export function uuidParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || !isUuid(value)) {
    throw AppError.badRequest('INVALID_PATH_PARAM', '路径参数必须是 UUID');
  }
  return value;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
