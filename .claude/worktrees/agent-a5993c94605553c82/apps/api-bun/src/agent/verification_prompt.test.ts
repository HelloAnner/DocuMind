// 移植自 apps/api-rs/src/agent/verification_prompt.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import { INVENTORY_SYSTEM, PREMISE_SYSTEM, PRIMARY_SYSTEM, REFEREE_SYSTEM } from './verification_prompt.ts';

describe('verification prompts', () => {
  test('verification_prompts_preserve_untrusted_data_and_correction_boundaries', () => {
    expect(PRIMARY_SYSTEM).toContain('untrusted');
    expect(PRIMARY_SYSTEM).toContain('corrected_answer');
    expect(INVENTORY_SYSTEM).toContain('premise inventory');
    expect(PREMISE_SYSTEM).toContain('proposition and quantifier');
    expect(REFEREE_SYSTEM).toContain('general knowledge');
  });
});
