// 移植自 apps/api-rs/src/agent/model.rs
import type { Usage } from '../models/index.ts';

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentToolCall {
  id: string; name: string; arguments_json: string;
}

export interface AgentMessage {
  role: AgentMessageRole;
  content: string | null;
  tool_calls: AgentToolCall[];
  tool_call_id: string | null;
}

export function agentSystemMessage(content: string): AgentMessage {
  return { role: 'system', content, tool_calls: [], tool_call_id: null };
}
export function agentUserMessage(content: string): AgentMessage {
  return { role: 'user', content, tool_calls: [], tool_call_id: null };
}
export function agentAssistantMessage(content: string): AgentMessage {
  return { role: 'assistant', content, tool_calls: [], tool_call_id: null };
}
export function agentAssistantWithTools(
  content: string | null, toolCalls: AgentToolCall[],
): AgentMessage {
  return { role: 'assistant', content, tool_calls: toolCalls, tool_call_id: null };
}
export function agentToolMessage(toolCallId: string, content: string): AgentMessage {
  return { role: 'tool', content, tool_calls: [], tool_call_id: toolCallId };
}

export interface AgentToolDefinition {
  name: string; description: string; parameters: unknown;
}

export interface AgentModelRequest {
  messages: AgentMessage[]; tools: AgentToolDefinition[];
  temperature: number; max_tokens: number;
}

export interface AgentModelResponse {
  content: string | null; tool_calls: AgentToolCall[];
  usage: Usage | null; finish_reason: string | null;
}
export function agentResponseHasContent(response: AgentModelResponse): boolean {
  return response.content !== null && response.content.trim().length > 0;
}

export type AgentModelStreamEvent =
  | { type: 'response_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string };

/** AgentModel 模型端口的 TS 形态：流事件通过回调推送。 */
export interface AgentModel {
  complete(request: AgentModelRequest): Promise<AgentModelResponse>;
  completeStreamed(
    request: AgentModelRequest,
    events: ((event: AgentModelStreamEvent) => void) | null,
  ): Promise<AgentModelResponse>;
  componentName(): string;
}
