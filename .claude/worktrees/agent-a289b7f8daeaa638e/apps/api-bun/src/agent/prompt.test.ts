// 移植自 apps/api-rs/src/agent/prompt.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import { BuiltinPromptRegistry } from './prompt.ts';
import { defaultAgentOptions } from '../models/agent.ts';

describe('builtin prompt registry', () => {
  test('prompt_keeps_tools_optional_and_document_claims_grounded', async () => {
    const prompt = await new BuiltinPromptRegistry().compose(defaultAgentOptions());
    expect(prompt.system_text).toContain('Do not call a tool');
    expect(prompt.system_text).toContain('knowledge_search');
    expect(prompt.system_text).toContain('cite');
    expect(prompt.system_text).toContain('current user message');
    expect(prompt.system_text).toContain('leave assistant content empty');
  });
});
