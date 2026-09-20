import { describe, expect, test } from 'bun:test';
import { chatModelCatalog, resolveChatModel } from './chat_models.ts';
import { loadConfig } from './config.ts';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost/test',
  LLM_BASE_URL: 'https://example.invalid/v1',
  LLM_API_KEY: 'test',
  LLM_MODEL: 'qwen3.8-max',
});

describe('chat model selection', () => {
  test('uses ENV model by default and enforces thinking capability', () => {
    expect(chatModelCatalog(config).default_model_id).toBe('qwen3.8-max');
    expect(resolveChatModel(config).model).toBe('qwen3.8-max');
    expect(resolveChatModel(config).thinkingEnabled).toBeUndefined();
    expect(resolveChatModel(config, 'deepseek-v4.1-flash', true).reasoningEffort).toBe('high');
    expect(() => resolveChatModel(config, 'glm-5.3', false)).toThrow('始终使用深度思考');
  });
});
