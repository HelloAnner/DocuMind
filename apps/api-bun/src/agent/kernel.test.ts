// 移植自 apps/api-rs/src/agent/kernel_tests.rs
import { describe, expect, test } from 'bun:test';
import { AgentKernel, type PreparedAgentRequest } from './kernel.ts';
import { GroundedAnswerFinalizer } from './finalizer.ts';
import type {
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
  AgentToolCall,
} from './model.ts';
import type { AgentProgress } from './events.ts';
import { BuiltinPromptRegistry } from './prompt.ts';
import { AgentToolRegistry } from './tools/registry.ts';
import { ClarificationTool } from './tools/clarification.ts';
import { KnowledgeSearchTool } from './tools/knowledge_search.ts';
import type { ClaimVerifier } from './verifier/types.ts';
import {
  defaultAgentOptions,
  type AgentRequest,
  type AgentRun,
  type CitationOutput,
  type ConversationTurn,
} from '../models/agent.ts';
import type {
  ContextInput,
  EvidencePack,
  RerankInput,
  RerankedChunk,
  RetrievedChunk,
  RetrievalInput,
  RetrievalOutput,
} from '../models/rag.ts';
import type { ContextAssembler, Reranker, Retriever } from '../rag/types.ts';
import type { Confidence } from '../models/index.ts';
import { newUuid } from '../infra/uuid.ts';

class QueuedModel implements AgentModel {
  constructor(
    private responses: AgentModelResponse[],
    readonly requests: AgentModelRequest[] = [],
  ) {}

  async complete(request: AgentModelRequest): Promise<AgentModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('test model response queue is empty');
    return response;
  }

  async completeStreamed(
    request: AgentModelRequest,
    events: ((event: import('./model.ts').AgentModelStreamEvent) => void) | null,
  ): Promise<AgentModelResponse> {
    const response = await this.complete(request);
    if (events !== null && response.content !== null && response.content.length > 0) {
      events({ type: 'response_delta', delta: response.content });
    }
    return response;
  }

  componentName(): string {
    return 'queued-agent-model';
  }
}

class RecordingRetriever implements Retriever {
  readonly calls: string[][] = [];
  constructor(private readonly returnChunks: boolean) {}

  async retrieve(input: RetrievalInput): Promise<RetrievalOutput> {
    this.calls.push([...input.queries]);
    const callNumber = this.calls.length;
    return {
      chunks: this.returnChunks ? [testChunk(callNumber)] : [],
      warnings: [],
    };
  }

  componentName(): string {
    return 'recording-retriever';
  }
}

class PassingReranker implements Reranker {
  async rerank(input: RerankInput): Promise<RerankedChunk[]> {
    return input.chunks.slice(0, input.top_k).map((chunk, index) => ({
      chunk,
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
  }): Promise<import('./verifier/types.ts').VerificationReport> {
    return {
      supported: true,
      confidence: 'high',
      issues: [],
      claims: [],
      corrected_answer: null,
    };
  }

  componentName(): string {
    return 'passing-verifier';
  }
}

// 移植自 apps/api-rs/src/rag/context.rs 的 SimpleContextAssembler（rag 模块就绪前测试本地使用）
class SimpleContextAssembler implements ContextAssembler {
  async assemble(input: ContextInput): Promise<EvidencePack> {
    const lines: string[] = [];
    const selected: RerankedChunk[] = [];
    let usedChars = 0;
    for (const chunk of input.chunks) {
      const chunkChars = [...chunk.chunk.content].length;
      if (selected.length > 0 && usedChars + chunkChars > Math.max(input.max_context_chars, 1)) {
        continue;
      }
      usedChars += chunkChars;
      selected.push(chunk);
    }
    selected.forEach((chunk, index) => {
      const oneBased = index + 1;
      const heading =
        chunk.chunk.heading_path.length === 0
          ? ''
          : ' > ' + chunk.chunk.heading_path.join(' > ');
      const page =
        chunk.chunk.page_range.length === 0
          ? ''
          : '第' + chunk.chunk.page_range.map((p) => String(p)).join('-');
      lines.push(
        '[' + oneBased + '] 文档: ' + chunk.chunk.doc_title + ' ' + page + heading + '\n' + chunk.chunk.content,
      );
    });
    return { chunks: selected, context_text: lines.join('\n\n') };
  }

  componentName(): string {
    return 'simple-context-assembler';
  }
}

describe('agent kernel', () => {
  test('direct_greeting_finishes_without_tools', async () => {
    const model = new QueuedModel([textResponse('你好！有什么我可以帮你的吗？')]);
    const retriever = new RecordingRetriever(true);
    const run = await kernel(model, retriever).run(request('你好'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('你好');
    expect(citations).toHaveLength(0);
    expect(confidence).toBe('medium');
    expect(retriever.calls).toHaveLength(0);
    expect(model.requests).toHaveLength(1);
    expect(run.trace.stop_reason).toBe('direct_response');
    expect(run.trace.react_steps![0]!.action).toBe('respond');
  });

  test('answer_tokens_stream_without_a_duplicate_response_step', async () => {
    const model = new QueuedModel([textResponse('你好！')]);
    const agent = kernel(model, new RecordingRetriever(true));
    const prepared = await agent.prepare(request('你好'));
    const events: AgentProgress[] = [];
    const progress = (event: AgentProgress) => {
      if (event.type === 'flush') {
        event.acknowledgement();
        return;
      }
      events.push(event);
    };
    await agent.runPrepared(prepared, progress);
    expect(events.some((event) => event.type === 'response_delta')).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'react_step_started' && event.action === 'respond',
      ),
    ).toBe(false);
  });

  test('model_can_search_twice_then_answer_with_citations', async () => {
    const model = new QueuedModel([
      toolResponse(searchCall('call-1', '合同付款条件')),
      toolResponse(searchCall('call-2', '合同验收条件')),
      textResponse('付款和验收条件分别见对应条款。[1][2]'),
    ]);
    const retriever = new RecordingRetriever(true);
    const run = await kernel(model, retriever).run(request('付款和验收分别怎么约定？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('[1][2]');
    expect(citations).toHaveLength(2);
    expect(confidence).toBe('high');
    expect(retriever.calls).toHaveLength(2);
    expect(run.trace.stop_reason).toBe('grounded_response');
    expect(run.trace.react_steps!.map((step) => step.action)).toEqual([
      'knowledge_search',
      'knowledge_search',
      'respond',
    ]);
    expect(run.trace.react_steps![0]!.queries).toEqual(['合同付款条件']);
    expect(run.trace.react_steps![0]!.retrieved_chunk_ids).toHaveLength(1);
    expect(run.trace.react_steps![0]!.accepted_chunk_ids).toHaveLength(1);
    expect(run.trace.keywords).toEqual(['合同']);
  });

  test('grounded_answer_is_not_generated_twice_when_citation_is_missing', async () => {
    const model = new QueuedModel([
      toolResponse(searchCall('search-roles', '钻井模块岗位职责')),
      textResponse('钻井大组长负责任务分发和自检，承包商负责班组任务。'),
    ]);
    const retriever = new RecordingRetriever(true);
    const run = await kernel(model, retriever).run(request('钻井模块有哪些岗位职责？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('钻井大组长');
    expect(answer).not.toContain('证据不足');
    expect(citations).toHaveLength(1);
    expect(confidence).toBe('high');
    expect(model.requests).toHaveLength(2);
    expect(run.trace.react_steps!.filter((step) => step.action === 'respond')).toHaveLength(1);
  });

  test('search_without_evidence_is_not_misclassified_as_direct_answer', async () => {
    const model = new QueuedModel([
      toolResponse(searchCall('search-empty', '不存在的制度')),
      textResponse('当前知识库中没有找到相关内容。'),
    ]);
    const retriever = new RecordingRetriever(false);
    const run = await kernel(model, retriever).run(request('不存在的制度怎么规定？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toContain('没有找到');
    expect(citations).toHaveLength(0);
    expect(confidence).toBe('low');
    expect(run.no_answer_reason).toBe('no_relevant_chunks');
    expect(run.trace.stop_reason).toBe('no_relevant_evidence_response');
  });

  test('clarification_tool_stops_without_retrieval', async () => {
    const call: AgentToolCall = {
      id: 'clarify-1',
      name: 'ask_clarification',
      arguments_json: JSON.stringify({
        question: '你指的是哪一份合同？',
        reason: '存在两个不同对象',
      }),
    };
    const model = new QueuedModel([toolResponse(call)]);
    const retriever = new RecordingRetriever(true);
    const run = await kernel(model, retriever).run(request('它的付款条件是什么？'));
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(answer).toBe('你指的是哪一份合同？');
    expect(citations).toHaveLength(0);
    expect(confidence).toBe('low');
    expect(run.mode).toBe('clarifier');
    expect(run.no_answer_reason).toBe('needs_clarification');
    expect(retriever.calls).toHaveLength(0);
  });

  test('duplicate_tool_call_executes_only_once', async () => {
    const repeated = searchCall('search-1', '采购合同付款条件');
    const model = new QueuedModel([
      toolResponse(repeated),
      toolResponse({ id: 'search-2', name: repeated.name, arguments_json: repeated.arguments_json }),
      textResponse('已根据现有证据回答。[1]'),
    ]);
    const retriever = new RecordingRetriever(true);
    const run = await kernel(model, retriever).run(request('采购合同付款条件是什么？'));
    await collectAnswer(run);

    expect(retriever.calls).toHaveLength(1);
    expect(
      run.trace.react_steps!.some((step) =>
        (step.warnings ?? []).some((item) => item.includes('identical')),
      ),
    ).toBe(true);
  });

  test('current_greeting_remains_last_user_message_after_document_history', async () => {
    const model = new QueuedModel([textResponse('你好！')]);
    const retriever = new RecordingRetriever(true);
    const req = request('你好');
    req.history.push({
      user_message: '合同验证码是什么？',
      assistant_answer: '验证码是 73941。[1]',
      citations: ['测试合同'],
    } satisfies ConversationTurn);
    const run = await kernel(model, retriever).run(req);
    await collectAnswer(run);

    const last = model.requests[0]!.messages[model.requests[0]!.messages.length - 1]!;
    expect(last.content).toBe('你好');
  });

  test('history_citation_cannot_bypass_current_turn_retrieval', async () => {
    const model = new QueuedModel([
      textResponse('历史里说城市是 HANGZHOU [1]。'),
      toolResponse(searchCall('search-current', 'PVSMOKE-747FE38D 城市')),
      textResponse('当前证据显示城市是 HANGZHOU [1]。'),
    ]);
    const retriever = new RecordingRetriever(true);
    const req = request('刚才那个 OCR 文档的城市呢？');
    req.history.push({
      user_message: 'OCR 文档 PVSMOKE-747FE38D 的验证码是什么？',
      assistant_answer: '验证码是 73941。[1]',
      citations: ['ocr-smoke-PVSMOKE-747FE38D'],
    } satisfies ConversationTurn);
    const run = await kernel(model, retriever).run(req);
    const { answer, citations, confidence } = await collectAnswer(run);

    expect(retriever.calls).toHaveLength(1);
    expect(answer).toContain('当前证据');
    expect(citations).toHaveLength(1);
    expect(confidence).toBe('high');
    expect(model.requests).toHaveLength(3);
    expect(
      (run.trace.react_steps![0]!.warnings ?? []).some((warning) =>
        warning.includes('no document evidence'),
      ),
    ).toBe(true);
  });
});

function kernel(model: QueuedModel, retriever: RecordingRetriever): AgentKernel {
  const tools = new AgentToolRegistry([
    new KnowledgeSearchTool(retriever, new PassingReranker()),
    new ClarificationTool(),
  ]);
  return new AgentKernel(
    model,
    tools,
    new SimpleContextAssembler(),
    new BuiltinPromptRegistry(),
    new GroundedAnswerFinalizer(new PassingVerifier()),
  );
}

function textResponse(content: string): AgentModelResponse {
  return {
    content: content,
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 5 },
    finish_reason: 'stop',
  };
}

function toolResponse(call: AgentToolCall): AgentModelResponse {
  return {
    content: null,
    tool_calls: [call],
    usage: { input_tokens: 10, output_tokens: 5 },
    finish_reason: 'tool_calls',
  };
}

function searchCall(id: string, query: string): AgentToolCall {
  return {
    id: id,
    name: 'knowledge_search',
    arguments_json: JSON.stringify({
      queries: [query],
      rerank_query: query,
      hypothetical_answer: null,
      response_mode: 'answerer',
      keywords: ['合同'],
      resolved_references: [],
      reason: '查找用户请求的文档事实',
    }),
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

export type { PreparedAgentRequest };
