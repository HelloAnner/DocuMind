import type { PiModelSettings } from './agent/pi/model.ts';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';

export type ThinkingMode = 'switchable' | 'always_on' | 'unsupported';

export interface ChatModelOption {
  id: string;
  name: string;
  thinking_mode: ThinkingMode;
  thinking_default: boolean;
}

const CAPABILITIES: Record<string, Omit<ChatModelOption, 'id'>> = {
  'deepseek-v4.1-flash': {
    name: 'DeepSeek V4.1 Flash', thinking_mode: 'switchable', thinking_default: false,
  },
  'qwen3.8-max': {
    name: 'Qwen 3.8 Max', thinking_mode: 'switchable', thinking_default: false,
  },
  'glm-5.3': {
    name: 'GLM 5.3', thinking_mode: 'always_on', thinking_default: true,
  },
};

export function chatModelCatalog(config: AppConfig): {
  default_model_id: string;
  models: ChatModelOption[];
} {
  const ids = [...new Set([config.rag.generation.model, ...config.chatModels])];
  return {
    default_model_id: config.rag.generation.model,
    models: ids.map((id) => ({
      id,
      ...(CAPABILITIES[id] ?? {
        name: id, thinking_mode: 'unsupported' as const, thinking_default: false,
      }),
    })),
  };
}

export function resolveChatModel(
  config: AppConfig,
  requestedModel?: string,
  requestedThinking?: boolean,
): PiModelSettings {
  const catalog = chatModelCatalog(config);
  const id = requestedModel?.trim() || catalog.default_model_id;
  const option = catalog.models.find((model) => model.id === id);
  if (!option) throw AppError.badRequest('CHAT_MODEL_NOT_AVAILABLE', '对话模型不可用');
  if (option.thinking_mode === 'always_on' && requestedThinking === false) {
    throw AppError.badRequest('THINKING_REQUIRED', `${option.name} 始终使用深度思考`);
  }
  if (option.thinking_mode === 'unsupported' && requestedThinking === true) {
    throw AppError.badRequest('THINKING_UNSUPPORTED', `${option.name} 不支持深度思考`);
  }
  const thinkingEnabled = option.thinking_mode === 'always_on'
    ? true
    : option.thinking_mode === 'switchable' ? requestedThinking ?? false : false;
  const generation = config.rag.generation;
  return {
    model: id,
    name: option.name,
    baseUrl: generation.baseUrl,
    apiKey: generation.apiKey,
    contextWindow: generation.contextWindow,
    maxTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    thinkingEnabled,
    reasoningEffort: thinkingEnabled && id === 'deepseek-v4.1-flash' ? 'high' : undefined,
  };
}
