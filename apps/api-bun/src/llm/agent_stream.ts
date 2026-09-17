// 移植自 apps/api-rs/src/llm/agent_stream.rs —— Agent 流式协议状态机
import type { AgentModelResponse, AgentModelStreamEvent, AgentToolCall } from '../agent/model.ts';
import type { Usage } from '../models/index.ts';

interface PendingToolCall { id: string; name: string; arguments: string; }

export class AgentStreamState {
  content = '';
  toolCalls = new Map<number, PendingToolCall>();
  usage: Usage | null = null;
  finishReason: string | null = null;

  intoResponse(): AgentModelResponse {
    const toolCalls: AgentToolCall[] = [];
    for (const call of [...this.toolCalls.values()].sort((a, b) => 0)) {
      if (call.id.length === 0) throw new Error('streamed tool call is missing id');
      if (call.name.length === 0) throw new Error('streamed tool call is missing name');
      toolCalls.push({
        id: call.id, name: call.name,
        arguments_json: call.arguments.length === 0 ? '{}' : call.arguments,
      });
    }
    const content = this.content.length > 0 ? this.content : null;
    if (content === null && toolCalls.length === 0) {
      throw new Error('agent stream completed without content or tool calls');
    }
    return { content, tool_calls: toolCalls, usage: this.usage, finish_reason: this.finishReason };
  }
}

export function findStreamSeparator(buffer: string): [number, number] | null {
  const unix = buffer.indexOf('\n\n');
  const windows = buffer.indexOf('\r\n\r\n');
  if (unix !== -1 && windows !== -1) return unix < windows ? [unix, 2] : [windows, 4];
  if (unix !== -1) return [unix, 2];
  if (windows !== -1) return [windows, 4];
  return null;
}

type EventSink = ((event: AgentModelStreamEvent) => void) | null;

export function applyStreamFrame(frame: string, state: AgentStreamState, events: EventSink): boolean {
  let data = '';
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const value = trimmed.slice('data:'.length).trim();
    if (value === '[DONE]') return true;
    if (data.length > 0) data += '\n';
    data += value;
  }
  if (data.length === 0) return false;

  const payload = JSON.parse(data) as Record<string, unknown>;
  const error = payload.error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') throw new Error(`agent stream provider error: ${message}`);
  }
  const usage = payload.usage;
  if (typeof usage === 'object' && usage !== null) {
    const record = usage as Record<string, unknown>;
    state.usage = {
      input_tokens: Number(record.prompt_tokens ?? 0),
      output_tokens: Number(record.completion_tokens ?? 0),
    };
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const choice = choices[0] as Record<string, unknown>;
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (typeof delta !== 'object' || delta === null) return false;
  const record = delta as Record<string, unknown>;

  if (typeof record.content === 'string' && record.content.length > 0) {
    state.content += record.content;
    events?.({ type: 'response_delta', delta: record.content });
  }
  const thinking = (record.reasoning_content ?? record.reasoning) as string | undefined;
  if (typeof thinking === 'string' && thinking.length > 0) {
    events?.({ type: 'thinking_delta', delta: thinking });
  }
  if (Array.isArray(record.tool_calls)) {
    record.tool_calls.forEach((toolCall: unknown, fallbackIndex: number) => {
      const call = toolCall as Record<string, unknown>;
      const index = typeof call.index === 'number' ? call.index : fallbackIndex;
      let pending = state.toolCalls.get(index);
      if (!pending) { pending = { id: '', name: '', arguments: '' }; state.toolCalls.set(index, pending); }
      if (typeof call.id === 'string') appendStreamFragment(pending, 'id', call.id);
      const fn = call.function;
      if (typeof fn === 'object' && fn !== null) {
        const fnRecord = fn as Record<string, unknown>;
        if (typeof fnRecord.name === 'string') appendStreamFragment(pending, 'name', fnRecord.name);
        if (typeof fnRecord.arguments === 'string') pending.arguments += fnRecord.arguments;
      }
    });
  }
  return false;
}

function appendStreamFragment(target: PendingToolCall, field: 'id' | 'name', fragment: string): void {
  if (fragment.length === 0 || target[field] === fragment) return;
  target[field] += fragment;
}
