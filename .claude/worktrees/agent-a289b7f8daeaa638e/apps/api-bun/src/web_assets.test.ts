import { expect, test } from 'bun:test';
import { routeCandidates } from './web_assets.ts';

test('dynamic share links resolve to the exported placeholder page', () => {
  expect(routeCandidates('/s/shr_example')).toContain('s/__placeholder__.html');
  expect(routeCandidates('/documind/s/shr_example')).toContain('s/__placeholder__.html');
});
