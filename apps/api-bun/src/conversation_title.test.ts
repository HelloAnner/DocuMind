import { describe, expect, test } from 'bun:test';
import { normalizeTitle, shouldGenerateTitle } from './conversation_title.ts';

describe('conversation title', () => {
  test('title update cadence is preserved', () => {
    const due = [...Array(12).keys()].filter((count) => shouldGenerateTitle(count));
    expect(due).toEqual([1, 3, 7, 11]);
  });
  test('title is normalized and limited to ten characters', () => {
    expect(normalizeTitle('标题：“请帮我分析企业知识库检索性能优化”\n解释'))
      .toBe('分析企业知识库检索性');
  });
});
