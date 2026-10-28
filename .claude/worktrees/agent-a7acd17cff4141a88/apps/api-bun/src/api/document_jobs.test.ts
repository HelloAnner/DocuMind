// 移植自 apps/api-rs/src/api/document_jobs.rs 的 #[cfg(test)] 用例
import { expect, test } from 'bun:test';
import { displayStatus } from './document_jobs.ts';

test('maps_pipeline_states', () => {
  expect(displayStatus('pending', null, 'uploaded')).toEqual(['queued', 'waiting_parse']);
  expect(displayStatus('completed', 'running', 'embedding')).toEqual(['processing', 'embedding']);
  expect(displayStatus('completed', 'completed', 'indexed')).toEqual(['completed', 'indexed']);
});
