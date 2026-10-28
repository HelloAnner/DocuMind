// pi core 事件与消息辅助：AgentEvent / AgentMessage -> DocuMind 领域值
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, Usage as PiUsage } from '@earendil-works/pi-ai';
import type { Usage } from '../../models/index.ts';

export function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

/** 助手消息的可见正文；无文本块时返回 null。 */
export function assistantText(message: AgentMessage): string | null {
  if (!isAssistantMessage(message)) return null;
  const text = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return text.length > 0 ? text : null;
}

/** 最后一条助手消息；模型调用失败时用它读取 stopReason / errorMessage。 */
export function lastAssistantMessage(messages: AgentMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && isAssistantMessage(message)) return message;
  }
  return null;
}

export function toolCallsOf(message: AgentMessage): ToolCall[] {
  if (!isAssistantMessage(message)) return [];
  return message.content.filter((block): block is ToolCall => block.type === 'toolCall');
}

export function toolCallNames(message: AgentMessage): string[] {
  return toolCallsOf(message).map((call) => call.name);
}

export function usageToDocuMind(usage: PiUsage): Usage {
  return { input_tokens: usage.input, output_tokens: usage.output };
}

/** 从工具结果载荷中提取可读文本，用于失败观测。 */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (typeof result !== 'object' || result === null) return String(result);
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const text = content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((item) => item.length > 0)
    .join('\n');
  return text.length > 0 ? text : JSON.stringify(result);
}
