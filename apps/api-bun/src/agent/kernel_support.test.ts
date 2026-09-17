// 移植自 apps/api-rs/src/agent/kernel_support.rs 的 #[cfg(test)]
import { describe, expect, test } from 'bun:test';
import {
  boundedHistory,
  emptyAppliedToolTrace,
  successfulToolStep,
} from './kernel_support.ts';
import type { AgentToolCall } from './model.ts';
import { nowRfc3339 } from '../infra/time.ts';

describe('kernel support', () => {
  test('bounded_history_keeps_recent_turns', () => {
    const history = [
      { user_message: 'old', assistant_answer: 'old answer', citations: [] as string[] },
      { user_message: 'new', assistant_answer: 'new answer', citations: [] as string[] },
    ];
    const selected = boundedHistory(history, 1, 1000);
    expect(selected).toHaveLength(1);
    expect(selected[0].user_message).toBe('new');
  });

  test('successful_tool_step_preserves_public_call_details', () => {
    const call: AgentToolCall = {
      id: 'call-1',
      name: 'knowledge_search',
      arguments_json: '{"query":"DocuMind 架构"}',
    };
    const argumentsValue = { query: 'DocuMind 架构' };
    const publicResult = {
      matches: [{ document: '架构说明', content: 'Rust API 与 Next.js 前端' }],
    };
    const step = successfulToolStep(
      2,
      call,
      argumentsValue,
      publicResult,
      '需要检索架构文档',
      emptyAppliedToolTrace(),
      nowRfc3339(),
    );

    expect(step.step).toBe(2);
    expect(step.output).toBe('需要检索架构文档');
    expect(step.tool_calls).toHaveLength(1);
    expect(step.tool_calls![0].id).toBe('call-1');
    expect(step.tool_calls![0].arguments).toEqual(argumentsValue);
    expect(step.tool_calls![0].result).toEqual(publicResult);
    expect(step.tool_calls![0].status).toBe('succeeded');
    expect(step.tool_calls![0].error).toBeUndefined();
  });
});
