// pi-ai 模型接入：DocuMind 的 OpenAI 兼容端点（DashScope / Ollama / DeepSeek）
import type { Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { StreamFn } from '@earendil-works/pi-agent-core';

/** DocuMind 生成端点的连接与采样设置。 */
export interface PiModelSettings {
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
}

/** DocuMind 在 pi-ai 中的 provider 标识；实际路由由 baseUrl 决定。 */
export const DOCUMIND_PROVIDER = 'documind';

export function buildPiModel(settings: PiModelSettings): Model<'openai-completions'> {
  return {
    id: settings.model,
    name: settings.model,
    api: 'openai-completions',
    provider: DOCUMIND_PROVIDER,
    baseUrl: settings.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: settings.contextWindow,
    maxTokens: settings.maxTokens,
  };
}

/** Agent 的 streamFn：把连接事实与采样参数注入每次模型请求。 */
export function buildPiStreamFn(settings: PiModelSettings): StreamFn {
  const model = buildPiModel(settings);
  const streamFn: StreamFn = (_model, context: Context, options?: SimpleStreamOptions) =>
    streamSimple(model, context, {
      ...options,
      apiKey: settings.apiKey,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    });
  return streamFn;
}

/** 一次性文本补全（会话标题等辅助调用）；不进入 Agent 循环。 */
export async function completePiText(
  settings: PiModelSettings,
  systemPrompt: string,
  userText: string,
): Promise<string> {
  const context: Context = {
    systemPrompt: systemPrompt,
    messages: [{ role: 'user', content: userText, timestamp: Date.now() }],
  };
  const message = await streamSimple(buildPiModel(settings), context, {
    apiKey: settings.apiKey,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  }).result();
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function piComponentName(settings: PiModelSettings): string {
  return 'pi-openai-completions:' + settings.model;
}
