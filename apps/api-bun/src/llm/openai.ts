// 移植自 apps/api-rs/src/llm/openai.rs —— OpenAI 兼容客户端
import type { Usage } from '../models/index.ts';

export interface OpenAiClientConfig {
  baseUrl: string; apiKey: string; model: string; timeoutSeconds: number;
}
export function defaultOpenAiClientConfig(): OpenAiClientConfig {
  return { baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'qwen2.5:14b', timeoutSeconds: 120 };
}

export interface ChatMessage { role: string; content: string; }

export interface LlmStreamErrorShape { code: string; message: string; }
export function llmStreamProviderError(status: number, message: string): LlmStreamErrorShape {
  return { code: status === 401 ? 'LLM_UNAUTHORIZED' : 'LLM_PROVIDER_ERROR', message };
}
export function llmStreamError(message: string): LlmStreamErrorShape {
  return { code: 'LLM_STREAM_ERROR', message };
}

export type ParsedStreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' };

export function findSseSeparator(buffer: string): [number, number] | null {
  const unix = buffer.indexOf('\n\n');
  const windows = buffer.indexOf('\r\n\r\n');
  if (unix !== -1 && windows !== -1) return unix < windows ? [unix, 2] : [windows, 4];
  if (unix !== -1) return [unix, 2];
  if (windows !== -1) return [windows, 4];
  return null;
}

export function parseSseEvent(eventText: string): ParsedStreamEvent {
  let data = '';
  for (const line of eventText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') return { kind: 'done' };
      if (data.length > 0) data += '\n';
      data += payload;
    }
  }
  if (data.length === 0) return { kind: 'empty' };
  let value: unknown;
  try { value = JSON.parse(data); } catch { return { kind: 'empty' }; }
  if (typeof value !== 'object' || value === null) return { kind: 'empty' };
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return { kind: 'error', message };
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: 'empty' };
  const choice = choices[0] as Record<string, unknown>;
  if (choice.finish_reason != null) return { kind: 'done' };
  const delta = choice.delta;
  if (typeof delta !== 'object' || delta === null) return { kind: 'empty' };
  const content = (delta as Record<string, unknown>).content;
  if (typeof content === 'string' && content.length > 0) return { kind: 'delta', text: content };
  return { kind: 'empty' };
}

export function providerErrorMessage(status: number, body: string): string {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const error = value.error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return `LLM provider returned ${status}: ${message}`;
    }
    if (typeof value.message === 'string') return `LLM provider returned ${status}: ${value.message}`;
  } catch { /* fall through */ }
  const trimmed = body.trim();
  return trimmed.length === 0
    ? `LLM provider returned ${status}`
    : `LLM provider returned ${status}: ${trimmed}`;
}

export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```json') && trimmed.endsWith('```')) {
    return trimmed.slice('```json'.length, trimmed.length - 3).trim();
  }
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    return trimmed.slice(3, trimmed.length - 3).trim();
  }
  return trimmed;
}

export function escapeControlCharactersInJsonStrings(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) { output += character; escaped = false; continue; }
    switch (character) {
      case '\\': output += character; escaped = true; break;
      case '"': output += character; inString = false; break;
      case '\n': output += '\\n'; break;
      case '\r': output += '\\r'; break;
      case '\t': output += '\\t'; break;
      case '\b': output += '\\b'; break;
      case '\f': output += '\\f'; break;
      default:
        if (character <= '\u001f') {
          output += '\\u' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
        } else {
          output += character;
        }
    }
  }
  return output;
}

export function parseJsonCompletion<T>(text: string): T {
  const stripped = stripJsonFences(text);
  try {
    return JSON.parse(stripped) as T;
  } catch (originalError) {
    const repaired = escapeControlCharactersInJsonStrings(stripped);
    try {
      return JSON.parse(repaired) as T;
    } catch (repairedError) {
      throw new Error(
        `invalid JSON completion: ${(originalError as Error).message}; control-character repair also failed: ${(repairedError as Error).message}`);
    }
  }
}

interface ChatCompletionPayload {
  model: string; messages: ChatMessage[]; temperature: number; max_tokens: number; stream: boolean;
}

export class OpenAiClient {
  readonly config: OpenAiClientConfig;

  constructor(config: OpenAiClientConfig) {
    this.config = config;
  }

  chatUrl(): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }
  authHeader(): string { return `Bearer ${this.config.apiKey}`; }

  private async requestJson<T>(
    prompt: string, system: string | null, temperature: number, maxTokens: number,
  ): Promise<T> {
    const messages: ChatMessage[] = [];
    if (system !== null) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    const payload: ChatCompletionPayload = {
      model: this.config.model, messages, temperature, max_tokens: maxTokens, stream: false,
    };
    const response = await fetch(this.chatUrl(), {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000),
    });
    if (!response.ok) {
      throw new Error(providerErrorMessage(response.status, await response.text()));
    }
    const payloadJson = (await response.json()) as Record<string, unknown>;
    const choices = (payloadJson.choices ?? []) as Array<Record<string, unknown>>;
    const firstChoice = choices[0];
    const content = firstChoice === undefined
      ? undefined
      : (firstChoice.message as Record<string, unknown> | undefined)?.content;
    if (typeof content !== 'string') throw new Error('missing content in completion response');
    return parseJsonCompletion<T>(content);
  }

  completeJson<T>(prompt: string, system: string | null): Promise<T> {
    return this.requestJson<T>(prompt, system, 0.2, 2048);
  }
  completeJsonWithOptions<T>(
    prompt: string, system: string | null, temperature: number, maxTokens: number,
  ): Promise<T> {
    return this.requestJson<T>(prompt, system, temperature, maxTokens);
  }

  /** 流式输出：返回异步迭代器，逐条产出 Ok(text) 或 Err(LlmStreamErrorShape)。 */
  async *streamChat(
    messages: ChatMessage[], temperature: number, maxTokens: number,
  ): AsyncGenerator<{ ok: true; text: string } | { ok: false; error: LlmStreamErrorShape }> {
    const payload: ChatCompletionPayload = {
      model: this.config.model, messages, temperature, max_tokens: maxTokens, stream: true,
    };
    let response: Response;
    try {
      response = await fetch(this.chatUrl(), {
        method: 'POST',
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000),
      });
    } catch (error) {
      yield { ok: false, error: llmStreamError((error as Error).message) };
      return;
    }
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => 'LLM provider returned an unreadable error body');
      yield { ok: false, error: llmStreamProviderError(response.status, providerErrorMessage(response.status, body)) };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const separator = findSseSeparator(buffer);
          if (!separator) break;
          const [position, separatorLength] = separator;
          const eventText = buffer.slice(0, position);
          buffer = buffer.slice(position + separatorLength);
          const event = parseSseEvent(eventText);
          if (event.kind === 'delta') { yield { ok: true, text: event.text }; continue; }
          if (event.kind === 'error') { yield { ok: false, error: llmStreamError(event.message) }; return; }
          if (event.kind === 'done') return;
        }
      }
      const rest = buffer.trim();
      if (rest.length > 0) {
        const event = parseSseEvent(rest);
        if (event.kind === 'delta') yield { ok: true, text: event.text };
        else if (event.kind === 'error') yield { ok: false, error: llmStreamError(event.message) };
      }
    } catch (error) {
      console.error('[documind][llm] stream error:', error);
      yield { ok: false, error: llmStreamError((error as Error).message) };
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  streamText(
    prompt: string, system: string | null, temperature: number, maxTokens: number,
  ): AsyncGenerator<{ ok: true; text: string } | { ok: false; error: LlmStreamErrorShape }> {
    const messages: ChatMessage[] = [];
    if (system !== null) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    return this.streamChat(messages, temperature, maxTokens);
  }
}
