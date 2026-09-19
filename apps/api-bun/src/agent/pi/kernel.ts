// pi core 内核：用 @earendil-works/pi-agent-core 的 Agent 承载对话循环与工具调用
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage as PiUsage } from '@earendil-works/pi-ai';
import type { Sql } from 'postgres';
import { citedEvidenceIndexes } from '../citation_resolver.ts';
import { emit, type ProgressSender } from '../events.ts';
import type { GroundedAnswerFinalizer } from '../finalizer.ts';
import type { Prompt, PromptRegistry } from '../prompt.ts';
import type { AnswerStream } from '../stream.ts';
import type {
  AgentMode,
  AgentRequest,
  AgentRun,
  AgentTrace,
  ConversationTurn,
} from '../../models/agent.ts';
import type { RerankedChunk } from '../../models/rag.ts';
import type { ContextAssembler, Reranker, Retriever } from '../../rag/types.ts';
import type { RetrievalTrace } from '../../models/trace.ts';
import { defaultRetrievalPlan } from '../../models/trace.ts';
import type { Confidence, NoAnswerReason, Usage } from '../../models/index.ts';
import { nowRfc3339 } from '../../infra/time.ts';
import { formatSkillsForSystemPrompt, listSkills } from '../../api/admin_skills.ts';
import {
  DOCUMIND_PROVIDER,
  buildPiModel,
  piComponentName,
  type PiModelSettings,
} from './model.ts';
import {
  assistantText,
  isAssistantMessage,
  lastAssistantMessage,
  toolCallNames,
  toolCallsOf,
  toolResultText,
} from './events.ts';
import {
  applyToolEffect,
  baseTrace,
  buildRun,
  boundedHistory,
  emptyAppliedToolTrace,
  failedResponseStep,
  failedToolStep,
  responseStep,
  singleTextStream,
  successfulToolStep,
  toolStepSummary,
  type AppliedToolEffect,
  type ToolState,
} from './support.ts';
import {
  createClarificationTool,
  createKnowledgeSearchTool,
  createSkillReadTool,
  createSkillSaveTool,
  type TerminalToolEffect,
  type ToolRunContext,
} from './tools.ts';
const GROUNDING_GUARD_MESSAGE =
  'Runtime grounding guard: citation markers are invalid because this turn has no document evidence. Call knowledge_search to obtain current evidence, or answer without document claims and citations.';

const GROUNDING_GUARD_WARNING =
  'citation markers rejected because this turn has no document evidence';

const KNOWLEDGE_GUARD_MESSAGE =
  'Runtime knowledge guard: this is a factual question in an authorized enterprise knowledge-base context. Call knowledge_search before answering.';

const KNOWLEDGE_GUARD_WARNING =
  'direct factual response rejected because authorized knowledge bases were not searched';

const BUDGET_EXHAUSTED_ANSWER = '已达到本次处理步骤上限，暂时无法可靠完成这个问题。';

export class PreparedAgentRequest {
  constructor(
    readonly request: AgentRequest,
    readonly bounded_history: ConversationTurn[],
    readonly prompt: Prompt,
    readonly mode: AgentMode,
    readonly started_at: string,
  ) {}

  standaloneQuery(): string {
    return this.request.original_query;
  }

  contextFingerprintInput(): string {
    const utcDate = new Date().toISOString().slice(0, 10);
    return JSON.stringify({ history: this.bounded_history, utc_date: utcDate });
  }
}

export interface PiKernelOptions {
  /** 生成端点连接与采样设置。 */
  settings: PiModelSettings;
  /** Agent 的模型传输；生产为 pi-ai openai-completions，测试可注入脚本模型。 */
  streamFn: StreamFn;
  retriever: Retriever;
  reranker: Reranker;
  contextAssembler: ContextAssembler;
  promptRegistry: PromptRegistry;
  answerFinalizer: GroundedAnswerFinalizer;
  sql?: Sql | null;
}

export class PiAgentKernel {
  constructor(readonly options: PiKernelOptions) {}

  get knowledgeSearchComponent(): string {
    return this.options.retriever.componentName() + '+' + this.options.reranker.componentName();
  }

  async prepare(request: AgentRequest): Promise<PreparedAgentRequest> {
    const bounded = boundedHistory(
      request.history,
      request.options.runtime.max_history_turns,
      request.options.runtime.max_history_chars,
    );
    const basePrompt = await this.options.promptRegistry.compose(request.options);
    const skills = this.options.sql ? await listSkills(this.options.sql, request.tenant_id) : [];
    const prompt = {
      ...basePrompt,
      system_text: basePrompt.system_text + '\n\n' + formatSkillsForSystemPrompt(skills),
    };
    const mode: AgentMode = request.options.mode ?? 'answerer';
    return new PreparedAgentRequest(request, bounded, prompt, mode, nowRfc3339());
  }

  async run(request: AgentRequest, progress: ProgressSender = null): Promise<AgentRun> {
    const prepared = await this.prepare(request);
    return this.runPrepared(prepared, progress);
  }

  async runPrepared(
    prepared: PreparedAgentRequest,
    progress: ProgressSender,
  ): Promise<AgentRun> {
    const request = prepared.request;
    const options = this.options;
    emit(progress, { type: 'status_updated', status: 'understanding' });
    emit(progress, {
      type: 'rewrite_completed',
      rewritten_query: request.original_query,
      keywords: [],
    });

    const trace: AgentTrace = baseTrace(prepared, {
      reasoner: piComponentName(options.settings),
      search: this.knowledgeSearchComponent,
      verifier: options.answerFinalizer.componentName(),
    });
    const reactSteps = trace.react_steps ?? [];
    trace.react_steps = reactSteps;

    const state: ToolState = {
      evidence: [],
      retrievalTraces: [],
      plan: defaultRetrievalPlan(),
      keywords: trace.keywords,
      resolvedRefs: trace.resolved_refs,
      mode: prepared.mode,
      rewrittenQuery: request.original_query,
      maxContextChars: request.options.runtime.max_context_chars,
    };
    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
    const seenCalls = new Set<string>();
    const appliedByCall = new Map<string, AppliedToolEffect>();
    const callInfoByCall = new Map<string, ToolCallInfo>();
    const turnOutput = new Map<number, string | null>();
    const toolBatchStarted = new Set<number>();
    let clarification: TerminalToolEffect | null = null;
    let documentSearchAttempted = false;
    let turnCount = 0;
    let groundingGuardUsed = false;
    let knowledgeGuardUsed = false;
    let currentTurnToolNames: string[] = [];

    const toolContext: ToolRunContext = {
      request: request,
      progress: progress,
      state: state,
      retriever: options.retriever,
      reranker: options.reranker,
      sql: options.sql ?? null,
      recordApplied: (callId, applied) => {
        appliedByCall.set(callId, applied);
        if (applied.documentSearchAttempted) documentSearchAttempted = true;
      },
      recordClarification: (terminal) => {
        clarification = terminal;
      },
    };
    const tools: AgentTool[] = [
      createKnowledgeSearchTool(options.retriever, options.reranker, toolContext),
      createClarificationTool(toolContext),
    ];
    if (options.sql) {
      tools.push(createSkillReadTool(toolContext));
      if (request.can_manage_skills) tools.push(createSkillSaveTool(toolContext));
    }

    const onEvent = async (event: AgentEvent): Promise<void> => {
      switch (event.type) {
        case 'turn_start':
          turnCount += 1;
          if (turnCount > 1 && state.evidence.length > 0) {
            emit(progress, { type: 'status_updated', status: 'generating' });
          }
          break;
        case 'message_update': {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_delta') {
            emit(progress, { type: 'response_delta', delta: update.delta });
          } else if (update.type === 'thinking_delta') {
            emit(progress, { type: 'thinking_delta', delta: update.delta });
          }
          break;
        }
        case 'message_end': {
          if (!isAssistantMessage(event.message)) break;
          currentTurnToolNames = toolCallNames(event.message);
          turnOutput.set(turnCount, assistantText(event.message));
          usage.input_tokens += event.message.usage.input;
          usage.output_tokens += event.message.usage.output;
          await flushProgress(progress);
          break;
        }
        case 'tool_execution_start': {
          if (!toolBatchStarted.has(turnCount)) {
            toolBatchStarted.add(turnCount);
            emit(progress, {
              type: 'react_step_started',
              step: turnCount,
              action: 'tool',
              decision_summary: toolStepSummary(currentTurnToolNames),
            });
          }
          callInfoByCall.set(event.toolCallId, {
            startedAt: nowRfc3339(),
            args: event.args,
            name: event.toolName,
          });
          emit(progress, {
            type: 'tool_call_started',
            tool_call_id: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
          });
          break;
        }
        case 'tool_execution_end': {
          const info = callInfoByCall.get(event.toolCallId);
          const descriptor = {
            id: event.toolCallId,
            name: event.toolName,
            argumentsValue: info?.args ?? {},
          };
          const startedAt = info?.startedAt ?? nowRfc3339();
          const output = turnOutput.get(turnCount) ?? null;
          const applied = appliedByCall.get(event.toolCallId);
          if (event.isError) {
            const message = toolResultText(event.result);
            emit(progress, {
              type: 'tool_call_failed',
              tool_call_id: event.toolCallId,
              name: event.toolName,
              error: message,
            });
            reactSteps.push(
              failedToolStep(turnCount, descriptor, message, output, message, startedAt),
            );
          } else {
            const publicResult = applied?.publicResult ?? event.result;
            emit(progress, {
              type: 'tool_call_completed',
              tool_call_id: event.toolCallId,
              name: event.toolName,
              result: publicResult,
            });
            reactSteps.push(
              successfulToolStep(
                turnCount,
                descriptor,
                publicResult,
                output,
                applied?.trace ?? emptyAppliedToolTrace(),
                startedAt,
              ),
            );
          }
          if (state.rewrittenQuery !== request.original_query) {
            emit(progress, {
              type: 'rewrite_completed',
              rewritten_query: state.rewrittenQuery,
              keywords: [],
            });
          }
          break;
        }
        default:
          break;
      }
    };

    let agent: Agent;
    agent = new Agent({
      streamFn: options.streamFn,
      toolExecution: 'sequential',
      initialState: {
        systemPrompt: prepared.prompt.system_text,
        model: buildPiModel(options.settings),
        thinkingLevel: 'off',
        tools: tools,
        messages: historyMessages(prepared, options.settings),
      },
      beforeToolCall: async (context) => {
        const fingerprint = context.toolCall.name + ':' + JSON.stringify(context.args);
        if (seenCalls.has(fingerprint)) {
          return {
            block: true,
            reason:
              'The identical tool call already ran. Change the query or answer from existing observations.',
          };
        }
        seenCalls.add(fingerprint);
        return undefined;
      },
      afterToolCall: async (context) =>
        context.toolCall.name === 'ask_clarification' ? { terminate: true } : undefined,
      shouldStopAfterTurn: (context) => {
        if (turnCount >= Math.max(request.options.runtime.max_react_steps, 1)) return true;
        const text = assistantText(context.message);
        if (
          text !== null &&
          state.evidence.length === 0 &&
          citedEvidenceIndexes(text).length > 0 &&
          !groundingGuardUsed
        ) {
          groundingGuardUsed = true;
          emit(progress, { type: 'response_reset' });
          reactSteps.push(failedResponseStep(turnCount, text, GROUNDING_GUARD_WARNING));
          agent.steer({
            role: 'user',
            content: GROUNDING_GUARD_MESSAGE,
            timestamp: Date.now(),
          });
          return false;
        }
        if (
          text !== null &&
          state.evidence.length === 0 &&
          !documentSearchAttempted &&
          !knowledgeGuardUsed &&
          requiresKnowledgeSearch(request.original_query)
        ) {
          knowledgeGuardUsed = true;
          emit(progress, { type: 'response_reset' });
          reactSteps.push(failedResponseStep(turnCount, text, KNOWLEDGE_GUARD_WARNING));
          agent.steer({
            role: 'user',
            content: KNOWLEDGE_GUARD_MESSAGE,
            timestamp: Date.now(),
          });
          return false;
        }
        return false;
      },
    });
    agent.subscribe(onEvent);

    await agent.prompt(request.original_query);

    const lastAssistant = lastAssistantMessage(agent.state.messages);
    if (lastAssistant !== null && lastAssistant.stopReason === 'error') {
      throw new Error(lastAssistant.errorMessage ?? 'pi agent model call failed');
    }

    // 只有"没有工具调用"的助手消息才是最终答案；带 tool_calls 的正文只是检索前言。
    const finalText = lastAssistant !== null && toolCallsOf(lastAssistant).length === 0
      ? assistantText(lastAssistant)
      : null;
    let mode = state.mode;
    let noAnswerReason: NoAnswerReason | null = null;
    let answerStream: AnswerStream;

    if (clarification !== null) {
      const terminal: TerminalToolEffect = clarification;
      mode = terminal.mode;
      noAnswerReason = terminal.no_answer_reason;
      answerStream = singleTextStream(terminal.answer, terminal.confidence, { ...usage });
      trace.stop_reason = 'waiting_for_clarification';
    } else if (finalText === null) {
      trace.stop_reason = 'react_budget_exhausted';
      noAnswerReason = 'no_relevant_chunks';
      answerStream = singleTextStream(BUDGET_EXHAUSTED_ANSWER, 'low', { ...usage });
    } else {
      reactSteps.push(responseStep(turnCount, finalText));
      if (state.evidence.length === 0) {
        const confidence: Confidence = documentSearchAttempted ? 'low' : 'medium';
        if (documentSearchAttempted) noAnswerReason = 'no_relevant_chunks';
        answerStream = singleTextStream(finalText, confidence, { ...usage });
        trace.stop_reason = documentSearchAttempted
          ? 'no_relevant_evidence_response'
          : 'direct_response';
      } else {
        emit(progress, { type: 'status_updated', status: 'verifying' });
        const assembled = await options.contextAssembler.assemble({
          chunks: [...state.evidence],
          original_query: request.original_query,
          max_context_chars: request.options.runtime.max_context_chars,
        });
        answerStream = await options.answerFinalizer.finalize(
          state.rewrittenQuery,
          finalText,
          assembled,
          request.options.require_citation,
          request.options.runtime.allow_verifier_correction,
          { ...usage },
        );
        trace.stop_reason = 'grounded_response';
      }
    }

    trace.mode = mode;
    trace.rewritten_query = state.rewrittenQuery;
    trace.retrieval_plan = state.plan;
    trace.usage = usage;
    return buildRun(
      prepared,
      mode,
      state.rewrittenQuery,
      trace,
      state.plan,
      state.retrievalTraces,
      answerStream,
      noAnswerReason,
    );
  }
}

interface ToolCallInfo {
  startedAt: string;
  args: unknown;
  name: string;
}

function historyMessages(
  prepared: PreparedAgentRequest,
  settings: PiModelSettings,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const turn of prepared.bounded_history) {
    messages.push({ role: 'user', content: turn.user_message, timestamp: Date.now() });
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: turn.assistant_answer }],
      api: 'openai-completions',
      provider: DOCUMIND_PROVIDER,
      model: settings.model,
      usage: zeroPiUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    });
  }
  return messages;
}

function zeroPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function requiresKnowledgeSearch(query: string): boolean {
  const text = query.trim();
  if (/^(你好|您好|嗨|谢谢|多谢|你是谁|介绍一下你自己)[?？!！。]?$/u.test(text)) return false;
  return /[?？]|是什么|多少|哪些|如何|怎么|何时|哪里|谁|是否|有没有|为何|为什么|文档|制度|合同|规定/u.test(text);
}

async function flushProgress(progress: ProgressSender): Promise<void> {
  if (progress === null) return;
  await new Promise<void>((resolve) => {
    emit(progress, { type: 'flush', acknowledgement: () => resolve() });
  });
}
