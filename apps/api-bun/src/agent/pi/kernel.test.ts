// pi core 内核测试：逐条对齐旧 ReAct kernel 的行为基线
import { describe, expect, test } from 'bun:test';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PiAgentKernel } from './kernel.ts';
import { GroundedAnswerFinalizer } from '../finalizer.ts';
import type { AgentProgress } from '../events.ts';
import { BuiltinPromptRegistry } from '../prompt.ts';
import type { ClaimVerifier, VerificationReport } from '../verifier/types.ts';
import {
  defaultAgentOptions,
  type AgentRequest,
  type AgentRun,
  type CitationOutput,
  type ConversationTurn,
} from '../../models/agent.ts';
import type {
  ContextInput,
  EvidencePack,
  RerankInput,
  RerankedChunk,
  RetrievedChunk,
  RetrievalInput,
  RetrievalOutput,
} from '../../models/rag.ts';
import type { Reranker, Retriever } from '../../rag/types.ts';
import { SimpleContextAssembler } from '../../rag/context.ts';
import type { Confidence } from '../../models/index.ts';
import { newUuid } from '../../infra/uuid.ts';
import type { PiModelSettings } from './model.ts';

const TEST_SETTINGS: PiModelSettings = {
  model: 'documind-test-model',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'test-key',
  contextWindow: 128_000,
  maxTokens: 1200,
  temperature: 0.2,
};

class RecordingRetriever implements Retriever {
  readonly calls: string[][] = [];
  constructor(private readonly returnChunks: boolean) {}

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    this.calls.push([...input.queries]);
    const callNumber = this.calls.length;
    return { chunks: this.returnChunks ? [testChunk(callNumber)] : [], warnings: [] };
  }

  componentName(): string {
    return 'recording-retriever';
  }
}

class PassingReranker implements Reranker {
  async rerank(input: RerankInput): Promise<RerankedChunk[]> {
    return input.chunks.slice(0, input.top_k).map((chunk, index) => ({
      chunk: chunk,
      score: 0.95,
      rank: index + 1,
    }));
  }

  componentName(): string {
    return 'passing-reranker';
  }
}

class PassingVerifier implements ClaimVerifier {
  async verify(_input: {
    question: string;
    draft_answer: string;
    evidence: EvidencePack;
    require_citation: boolean;
  }): Promise<VerificationReport> {
    return { supported: true, confidence: 'high', issues: [], claims: [], corrected_answer: null };
  }

  componentName(): string {
    return 'passing-verifier';
  }
}

interface Harness {
  kernel: PiAgentKernel;
  retriever: RecordingRetriever;
  requests: Context[];
}

function harness(responses: ReturnType<typeof fauxAssistantMessage>[], withChunks = true): Harness {
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const requests: Context[] = [];
  const streamFn: StreamFn = (model, context, options) => {
    requests.push(context);
    return (faux.streamSimple as unknown as StreamFn)(model, context, options);
  };
  const retriever = new RecordingRetriever(withChunks);
  const kernel = new PiAgentKernel({
    settings: TEST_SETTINGS,
    streamFn: streamFn,
    retriever: retriever,
    reranker: new PassingReranker(),
    contextAssembler: new SimpleContextAssembler(),
    promptRegistry: new BuiltinPromptRegistry(),
    answerFinalizer: new GroundedAnswerFinalizer(new PassingVerifier()),
  });
  return { kernel: kernel, retriever: retriever, requests: requests };
}

describe('pi agent kernel', () => {
  test('direct_greeting_finishes_without_tools', async () => {
    const h = harness([fauxAssistantMessage('你好！有什么我可以帮你的吗？')]);
    const run = await h.kernel.run(request('你好'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('你好');
    expect(citations).toHaveLength(0);
    expect(confidence).toBe('medium');
    expect(h.retriever.calls).toHaveLength(0);
    expect(h.requests).toHaveLength(1);
    expect(run.trace.stop_reason).toBe('direct_response');
    expect(run.trace.react_steps![0]!.action).toBe('respond');
  });

  test('factual question cannot bypass authorized knowledge search', async () => {
    const h = harness([
      fauxAssistantMessage('唯一校验标记通常用于数据完整性。'),
      fauxAssistantMessage([fauxToolCall('knowledge_search', searchArgs('唯一校验标记'))]),
      fauxAssistantMessage('唯一校验标记是 CLI_PARSE_VERIFY_20260918。[1]'),
    ]);
    const run = await h.kernel.run(request('唯一校验标记是什么？'));
    const { answer, citations } = await collectAnswer(run);

    expect(answer).toContain('CLI_PARSE_VERIFY_20260918');
    expect(citations).toHaveLength(1);
    expect(h.retriever.calls).toEqual([['唯一校验标记', '唯一校验标记是什么？']]);
    expect(run.trace.stop_reason).toBe('grounded_response');
  });

  test('answer_tokens_stream_without_a_duplicate_response_step', async () => {
    const h = harness([fauxAssistantMessage('你好！')]);
    const prepared = await h.kernel.prepare(request('你好'));
    const events: AgentProgress[] = [];
    const progress = (event: AgentProgress): void => {
      if (event.type === 'flush') {
        event.acknowledgement();
        return;
      }
      events.push(event);
    };
    await h.kernel.runPrepared(prepared, progress);
    expect(events.some((event) => event.type === 'response_delta')).toBe(true);
    expect(
      events.some((event) => event.type === 'react_step_started' && event.action === 'respond'),
    ).toBe(false);
  });

  test('model_can_search_twice_then_answer_with_citations', async () => {
    const h = harness([
      fauxAssistantMessage([fauxToolCall('knowledge_search', searchArgs('合同付款条件'))]),
      fauxAssistantMessage([fauxToolCall('knowledge_search', searchArgs('合同验收条件'))]),
      fauxAssistantMessage('付款和验收条件分别见对应条款。[1][2]'),
    ]);
    const run = await h.kernel.run(request('付款怎么约定；验收怎么约定？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('[1][2]');
    expect(citations).toHaveLength(2);
    expect(confidence).toBe('high');
    expect(h.retriever.calls).toHaveLength(2);
    expect(run.trace.stop_reason).toBe('grounded_response');
    expect(run.trace.react_steps!.map((step) => step.action)).toEqual([
      'knowledge_search',
      'knowledge_search',
      'respond',
    ]);
    expect(run.trace.react_steps![0]!.queries).toEqual([
      '合同付款条件',
      '付款怎么约定',
      '验收怎么约定？',
    ]);
    expect(run.trace.react_steps![0]!.retrieved_chunk_ids).toHaveLength(1);
    expect(run.trace.react_steps![0]!.accepted_chunk_ids).toHaveLength(1);
    expect(run.trace.keywords).toEqual(['合同']);
  });

  test('grounded_answer_is_not_generated_twice_when_citation_is_missing', async () => {
    const h = harness([
      fauxAssistantMessage([fauxToolCall('knowledge_search', searchArgs('钻井模块岗位职责'))]),
      fauxAssistantMessage('钻井大组长负责任务分发和自检，承包商负责班组任务。'),
    ]);
    const run = await h.kernel.run(request('钻井模块有哪些岗位职责？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('钻井大组长');
    expect(answer).not.toContain('证据不足');
    expect(citations).toHaveLength(1);
    expect(confidence).toBe('high');
    expect(h.requests).toHaveLength(2);
    expect(run.trace.react_steps!.filter((step) => step.action === 'respond')).toHaveLength(1);
  });

  test('search_without_evidence_is_not_misclassified_as_direct_answer', async () => {
    const h = harness([
      fauxAssistantMessage([fauxToolCall('knowledge_search', searchArgs('不存在的制度'))]),
      fauxAssistantMessage('当前知识库中没有找到相关内容。'),
    ], false);
    const run = await h.kernel.run(request('不存在的制度怎么规定？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('没有找到');
    expect(citations).toHaveLength(0);
    expect(confidence).toBe('low');
    expect(run.no_answer_reason).toBe('no_relevant_chunks');
    expect(run.trace.stop_reason).toBe('no_relevant_evidence_response');
  });

  test('clarification_tool_stops_without_retrieval', async () => {
    const h = harness([
      fauxAssistantMessage([fauxToolCall('ask_clarification', {
        question: '你指的是哪一份合同？',
        reason: '存在两个不同对象',
      })]),
    ]);
    const run = await h.kernel.run(request('它的付款条件是什么？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toBe('你指的是哪一份合同？');
    expect(citations).toHaveLength(0);
    expect(confidence).toBe('low');
    expect(run.mode).toBe('clarifier');
    expect(run.no_answer_reason).toBe('needs_clarification');
    expect(h.retriever.calls).toHaveLength(0);
  });

  test('duplicate_tool_call_executes_only_once', async () => {
    const repeated = searchArgs('采购合同付款条件');
    const h = harness([
      fauxAssistantMessage([fauxToolCall('knowledge_search', repeated)]),
      fauxAssistantMessage([fauxToolCall('knowledge_search', repeated)]),
      fauxAssistantMessage('已根据现有证据回答。[1]'),
    ]);
    const run = await h.kernel.run(request('采购合同付款条件是什么？'));
    await collectAnswer(run);

    expect(h.retriever.calls).toHaveLength(1);
    expect(
      run.trace.react_steps!.some((step) =>
        (step.warnings ?? []).some((item) => item.includes('identical')),
      ),
    ).toBe(true);
  });

  test('current_greeting_remains_last_user_message_after_document_history', async () => {
    const h = harness([fauxAssistantMessage('你好！')]);
    const req = request('你好');
    req.history.push({
      user_message: '合同验证码是什么？',
      assistant_answer: '验证码是 73941。[1]',
      citations: ['测试合同'],
    } satisfies ConversationTurn);
    const run = await h.kernel.run(req);
    await collectAnswer(run);

    const first = h.requests[0]!;
    const last = first.messages[first.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(messageText(last.content)).toBe('你好');
  });

  test('history_citation_cannot_bypass_current_turn_retrieval', async () => {
    const h = harness([
      fauxAssistantMessage('历史里说城市是 HANGZHOU [1]。'),
      fauxAssistantMessage([fauxToolCall('knowledge_search', searchArgs('PVSMOKE-747FE38D 城市'))]),
      fauxAssistantMessage('当前证据显示城市是 HANGZHOU [1]。'),
    ]);
    const req = request('刚才那个 OCR 文档的城市呢？');
    req.history.push({
      user_message: 'OCR 文档 PVSMOKE-747FE38D 的验证码是什么？',
      assistant_answer: '验证码是 73941。[1]',
      citations: ['ocr-smoke-PVSMOKE-747FE38D'],
    } satisfies ConversationTurn);
    const run = await h.kernel.run(req);
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(h.retriever.calls).toHaveLength(1);
    expect(answer).toContain('当前证据');
    expect(citations).toHaveLength(1);
    expect(confidence).toBe('high');
    expect(h.requests).toHaveLength(3);
    expect(
      (run.trace.react_steps![0]!.warnings ?? []).some((warning) =>
        warning.includes('no document evidence'),
      ),
    ).toBe(true);
  });
});

/** pi 会把 user content 规范化为文本块数组，这里统一取回纯文本。 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

function searchArgs(query: string): Record<string, unknown> {
  return {
    queries: [query],
    rerank_query: query,
    response_mode: 'answerer',
    keywords: ['合同'],
    reason: '查找用户请求的文档事实',
  };
}

function request(query: string): AgentRequest {
  const options = defaultAgentOptions();
  options.runtime.max_react_steps = 4;
  return {
    tenant_id: newUuid(),
    user_id: newUuid(),
    conversation_id: newUuid(),
    user_message_id: newUuid(),
    assistant_message_id: newUuid(),
    original_query: query,
    effective_kb_ids: [newUuid()],
    history: [],
    options: options,
  };
}

function testChunk(number: number): RetrievedChunk {
  return {
    chunk_id: newUuid(),
    doc_id: newUuid(),
    doc_title: '测试合同' + number,
    file_type: 'docx',
    content: '第' + number + '轮检索命中的真实证据内容',
    heading_path: ['合同条款'],
    page_range: [number],
    block_ids: [],
    table_ids: [],
    anchor_ids: [],
    primary_anchor_id: null,
    anchor_quality: 'structural',
    primary_anchor: null,
    anchors: [],
    metadata: {},
    score: 0.8,
    source: 'rrf',
  };
}

async function collectAnswer(run: AgentRun): Promise<{
  answer: string;
  citations: CitationOutput[];
  confidence: Confidence | null;
}> {
  let answer = '';
  const citations: CitationOutput[] = [];
  let confidence: Confidence | null = null;
  for await (const item of run.answerStream) {
    if (item.type === 'delta') answer += item.text;
    if (item.type === 'replace') answer = item.text;
    if (item.type === 'citation') citations.push(item.citation);
    if (item.type === 'completed') confidence = item.confidence;
  }
  return { answer, citations, confidence };
}

export type { ContextInput };
