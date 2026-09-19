import { describe, expect, test } from 'bun:test';
import { kbScopeHash, normalizeQuestion, questionFingerprint } from './answer_quality.ts';

describe('answer quality matching', () => {
  test('normalizes equivalent questions without erasing negation', () => {
    expect(normalizeQuestion('  允许提前付款吗？ ')).toBe('允许提前付款吗');
    expect(questionFingerprint('允许提前付款吗？')).toBe(questionFingerprint(' 允许提前付款吗 '));
    expect(questionFingerprint('不允许提前付款吗？')).not.toBe(questionFingerprint('允许提前付款吗？'));
    expect(kbScopeHash(['b', 'a', 'a'])).toBe(kbScopeHash(['a', 'b']));
  });
});
