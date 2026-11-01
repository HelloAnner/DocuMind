import { expect, test } from 'bun:test';
import { A2AClient } from '../src/a2a';

test('A2A 活动报告按工具 ID 合并，并保留具体检索词和结果摘要', async () => {
  const start = { id: 's1', kind: 'tool', tool: 'knowledge_search', text: '检索知识库', detail: '差旅报销标准', status: 'running' };
  const end = { ...start, status: 'completed', result: '找到 3 条证据' };
  const results = [start, end].map(step => ({ kind: 'status-update', status: { state: 'working', message: step.text }, metadata: { process_step: step } }));
  const client = new A2AClient('http://test.invalid', (async () => new Response(results.map(result => `data: ${JSON.stringify({ result })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
  const statuses: string[] = [];
  const report = await client.ask({ ticket: 'test', contextId: 'c', text: 'q', onStatus: text => statuses.push(text) });
  expect(report.process_steps).toEqual([end]);
  expect(statuses[0]).toContain('差旅报销标准');
});
