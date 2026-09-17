// 移植自 apps/api-rs/src/llm/agent_adapter.rs —— OpenAiClient 实现 AgentModel 端口
import {
  type AgentMessage, type AgentModel, type AgentModelRequest, type AgentModelResponse,
  type AgentModelStreamEvent, type AgentToolCall, type AgentToolDefinition,
} from '../agent/model.ts';
import type { Usage } from '../models/index.ts';
import { AgentStreamState, applyStreamFrame, findStreamSeparator } from './agent_stream.ts';
import type { OpenAiClient } from './openai.ts';

interface ToolChatFunction {
  name: string; description?: string; parameters?: unknown; arguments?: string;
}
interface ToolChatCall { id: string; type: string; function: ToolChatFunction; }
interface ToolChatMessage {
  role: string; content?: string | null; tool_calls?: ToolChatCall[]; tool_call_id?: string | null;
}
interface ToolDefinitionRequest { type: string; function: ToolChatFunction; }
interface ToolChatCompletionRequest {
  model: string; messages: ToolChatMessage[]; tools?: ToolDefinitionRequest[];
  tool_choice?: string; temperature: number; max_tokens: number; stream: boolean;
}
interface ToolChatResponseCall { id: string; function: { name: string; arguments: string } }
interface ToolChatResponseMessage { content: string | null; tool_calls?: ToolChatResponseCall[] }
interface ToolChatChoice { message: ToolChatResponseMessage; finish_reason: string | null }
interface ToolChatUsage { prompt_tokens?: number; completion_tokens?: number }
interface ToolChatCompletionResponse { choices: ToolChatChoice[]; usage?: ToolChatUsage }

function toolChatMessage(message: AgentMessage): ToolChatMessage {
  if (message.role === 'tool' && message.tool_call_id === null) {
    throw new Error('tool message is missing tool_call_id');
  }
  const toolCalls: ToolChatCall[] = message.tool_calls.map((call) => ({
    id: call.id, type: 'function',
    function: { name: call.name, arguments: call.arguments_json },
  }));
  const result: ToolChatMessage = { role: message.role, content: message.content };
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  if (message.tool_call_id !== null) result.tool_call_id = message.tool_call_id;
  return result;
}

function toolDefinitionRequest(definition: AgentToolDefinition): ToolDefinitionRequest {
  return {
    type: 'function',
    function: { name: definition.name, description: definition.description, parameters: definition.parameters },
  };
}

function requestPayload(
  model: string, request: AgentModelRequest, stream: boolean,
): ToolChatCompletionRequest {
  const messages = request.messages.map(toolChatMessage);
  const tools = request.tools.map(toolDefinitionRequest);
  const payload: ToolChatCompletionRequest = {
    model, messages, temperature: request.temperature, max_tokens: request.max_tokens, stream,
  };
  if (tools.length > 0) { payload.tools = tools; payload.tool_choice = 'auto'; }
  return payload;
}

function parseResponse(payload: ToolChatCompletionResponse): AgentModelResponse {
  const choice = payload.choices[0];
  if (!choice) throw new Error('missing choice in agent completion response');
  const toolCalls: AgentToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
    id: call.id, name: call.function.name, arguments_json: call.function.arguments,
  }));
  const usage: Usage | null = payload.usage
    ? {
        input_tokens: payload.usage.prompt_tokens ?? 0,
        output_tokens: payload.usage.completion_tokens ?? 0,
      }
    : null;
  return {
    content: choice.message.content, tool_calls: toolCalls,
    usage, finish_reason: choice.finish_reason,
  };
}

/** 为 OpenAiClient 附加 AgentModel 端口方法。 */
export function asAgentModel(client: OpenAiClient): AgentModel {
  return {
    async complete(request: AgentModelRequest): Promise<AgentModelResponse> {
      const payload = requestPayload(client.config.model, request, false);
      const response = await fetch(client.chatUrl(), {
        method: 'POST',
        headers: { Authorization: client.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(client.config.timeoutSeconds * 1000),
      });
      if (!response.ok) throw new Error(`agent provider returned ${response.status}: ${await response.text()}`);
      return parseResponse((await response.json()) as ToolChatCompletionResponse);
    },

    async completeStreamed(
      request: AgentModelRequest,
      events: ((event: AgentModelStreamEvent) => void) | null,
    ): Promise<AgentModelResponse> {
      const payload = requestPayload(client.config.model, request, true);
      const response = await fetch(client.chatUrl(), {
        method: 'POST',
        headers: { Authorization: client.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(client.config.timeoutSeconds * 1000),
      });
      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => 'unreadable provider error');
        throw new Error(`agent stream provider returned ${response.status}: ${body}`);
      }
      const state = new AgentStreamState();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      try {
        while (!done) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const separator = findStreamSeparator(buffer);
            if (!separator) break;
            const [position, separatorLength] = separator;
            const frame = buffer.slice(0, position);
            buffer = buffer.slice(position + separatorLength);
            done = applyStreamFrame(frame, state, events);
            if (done) break;
          }
        }
        if (!done && buffer.trim().length > 0) {
          applyStreamFrame(buffer.trim(), state, events);
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
      return state.intoResponse();
    },

    componentName(): string {
      return `openai-compatible-agent:${client.config.model}`;
    },
  };
}
