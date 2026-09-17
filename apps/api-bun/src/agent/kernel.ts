// 移植自 apps/api-rs/src/agent/kernel.rs
import { citedEvidenceIndexes } from './citation_resolver.ts';
import { emit, type AgentProgress, type ProgressSender } from './events.ts';
import { GroundedAnswerFinalizer } from './finalizer.ts';
import {
  applyToolEffect,
  baseTrace,
  boundedHistory,
  buildMessages,
  buildRun,
  failedResponseStep,
  failedToolStep,
  responseStep,
  singleTextStream,
  successfulToolStep,
  toolArgumentsValue,
  toolStepSummary,
  type AppliedToolTrace,
  type ToolState,
} from './kernel_support.ts';
import {
  agentAssistantMessage,
  agentAssistantWithTools,
  agentResponseHasContent,
  agentToolMessage,
  agentUserMessage,
  type AgentModel,
  type AgentModelRequest,
  type AgentModelResponse,
} from './model.ts';
import type { Prompt, PromptRegistry } from './prompt.ts';
import type { AnswerStream } from './stream.ts';
import { AgentToolRegistry, type AgentToolContext, type TerminalToolEffect } from './tools/index.ts';
import type { AgentMode, AgentRequest, AgentRun, AgentTrace, ConversationTurn } from '../models/agent.ts';
import type { RerankedChunk } from '../models/rag.ts';
import type { ContextAssembler } from '../rag/types.ts';
import type { RetrievalTrace } from '../models/trace.ts';
import { defaultRetrievalPlan } from '../models/trace.ts';
import type { Confidence, NoAnswerReason, Usage } from '../models/index.ts';
import { nowRfc3339 } from '../infra/time.ts';

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

export class AgentKernel {
  readonly knowledge_search_component: string;

  constructor(
    readonly model: AgentModel,
    readonly tools: AgentToolRegistry,
    readonly context_assembler: ContextAssembler,
    readonly prompt_registry: PromptRegistry,
    readonly answer_finalizer: GroundedAnswerFinalizer,
  ) {
    const component = tools.componentName('knowledge_search');
    if (component === null) {
      throw new Error('agent kernel requires the knowledge_search tool');
    }
    this.knowledge_search_component = component;
  }

  async prepare(request: AgentRequest): Promise<PreparedAgentRequest> {
    const bounded = boundedHistory(
      request.history,
      request.options.runtime.max_history_turns,
      request.options.runtime.max_history_chars,
    );
    const prompt = await this.prompt_registry.compose(request.options);
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
    emit(progress, { type: 'status_updated', status: 'understanding' });
    emit(progress, {
      type: 'rewrite_completed',
      rewritten_query: request.original_query,
      keywords: [],
    });

    const trace: AgentTrace = baseTrace(prepared, this);
    const messages = buildMessages(prepared);
    const definitions = this.tools.definitions();
    const evidence: RerankedChunk[] = [];
    const retrievalTraces: RetrievalTrace[] = [];
    const plan = defaultRetrievalPlan();
    let mode = prepared.mode;
    let rewrittenQuery = request.original_query;
    let answerStream: AnswerStream | null = null;
    let noAnswerReason: NoAnswerReason | null = null;
    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
    const seenCalls = new Set<string>();
    let emptyResponses = 0;
    let documentSearchAttempted = false;

    const reactSteps = trace.react_steps ?? [];
    trace.react_steps = reactSteps;

    const maxSteps = Math.max(request.options.runtime.max_react_steps, 1);
    for (let step = 1; step <= maxSteps; step++) {
      if (evidence.length > 0) {
        emit(progress, { type: 'status_updated', status: 'generating' });
      }
      const response = await this.completeModel(
        {
          messages: [...messages],
          tools: [...definitions],
          temperature: request.options.generation.temperature,
          max_tokens: request.options.generation.max_output_tokens,
        },
        progress,
      );
      if (response.usage !== null) {
        usage.input_tokens += response.usage.input_tokens;
        usage.output_tokens += response.usage.output_tokens;
      }

      if (response.tool_calls.length > 0) {
        emptyResponses = 0;
        const stepOutput =
          response.content !== null && response.content.trim().length > 0
            ? response.content.trim()
            : null;
        emit(progress, {
          type: 'react_step_started',
          step: step,
          action: 'tool',
          decision_summary: toolStepSummary(response.tool_calls),
        });
        messages.push(agentAssistantWithTools(response.content, [...response.tool_calls]));
        let terminal: TerminalToolEffect | null = null;
        for (const call of response.tool_calls) {
          const startedAt = nowRfc3339();
          const argumentsValue = toolArgumentsValue(call.arguments_json);
          emit(progress, {
            type: 'tool_call_started',
            tool_call_id: call.id,
            name: call.name,
            arguments: argumentsValue,
          });
          const fingerprint = call.name + ':' + call.arguments_json;
          if (seenCalls.has(fingerprint)) {
            const error = {
              error_type: 'duplicate_tool_call',
              retryable: false,
              message:
                'The identical tool call already ran. Change the query or answer from existing observations.',
            };
            emitToolFailure(progress, call.id, call.name, error);
            messages.push(agentToolMessage(call.id, JSON.stringify(error)));
            reactSteps.push(
              failedToolStep(
                step,
                call,
                argumentsValue,
                error,
                stepOutput,
                'identical tool call rejected',
                startedAt,
              ),
            );
            continue;
          }
          seenCalls.add(fingerprint);

          const context: AgentToolContext = { request: request, progress: progress };
          try {
            const execution = await this.tools.execute(call, context);
            const previousQuery = rewrittenQuery;
            const state: ToolState = {
              evidence: evidence,
              retrievalTraces: retrievalTraces,
              plan: plan,
              keywords: trace.keywords,
              resolvedRefs: trace.resolved_refs,
              mode: mode,
              rewrittenQuery: rewrittenQuery,
              maxContextChars: request.options.runtime.max_context_chars,
            };
            const applied = applyToolEffect(
              execution.effect,
              execution.model_result,
              execution.public_result,
              state,
            );
            mode = state.mode;
            rewrittenQuery = state.rewrittenQuery;
            documentSearchAttempted =
              documentSearchAttempted || applied.documentSearchAttempted;
            if (rewrittenQuery !== previousQuery) {
              emit(progress, {
                type: 'rewrite_completed',
                rewritten_query: rewrittenQuery,
                keywords: [],
              });
            }
            const publicResult = applied.publicResult;
            emit(progress, {
              type: 'tool_call_completed',
              tool_call_id: call.id,
              name: call.name,
              result: publicResult,
            });
            messages.push(agentToolMessage(call.id, JSON.stringify(applied.modelResult)));
            const details: AppliedToolTrace = applied.trace;
            reactSteps.push(
              successfulToolStep(
                step,
                call,
                argumentsValue,
                publicResult,
                stepOutput,
                details,
                startedAt,
              ),
            );
            if (applied.terminal !== null) terminal = applied.terminal;
          } catch (error) {
            const payload = {
              error_type: 'tool_execution_error',
              retryable: false,
              message: error instanceof Error ? error.message : String(error),
            };
            emitToolFailure(progress, call.id, call.name, payload);
            messages.push(agentToolMessage(call.id, JSON.stringify(payload)));
            reactSteps.push(
              failedToolStep(
                step,
                call,
                argumentsValue,
                payload,
                stepOutput,
                payload.message,
                startedAt,
              ),
            );
          }
        }
        if (terminal !== null) {
          mode = terminal.mode;
          noAnswerReason = terminal.no_answer_reason;
          answerStream = singleTextStream(terminal.answer, terminal.confidence, { ...usage });
          trace.stop_reason = 'waiting_for_clarification';
          break;
        }
        continue;
      }

      if (agentResponseHasContent(response)) {
        if (response.content === null) {
          throw new Error('agent response content disappeared');
        }
        const content = response.content;
        const citationIndexes = citedEvidenceIndexes(content);
        if (evidence.length === 0 && citationIndexes.length > 0) {
          messages.push(agentAssistantMessage(content));
          messages.push(
            agentUserMessage(
              'Runtime grounding guard: citation markers are invalid because this turn has no document evidence. Call knowledge_search to obtain current evidence, or answer without document claims and citations.',
            ),
          );
          reactSteps.push(
            failedResponseStep(
              step,
              content,
              'citation markers rejected because this turn has no document evidence',
            ),
          );
          emit(progress, { type: 'response_reset' });
          continue;
        }
        reactSteps.push(responseStep(step, content));
        if (evidence.length === 0) {
          let confidence: Confidence;
          if (documentSearchAttempted) {
            noAnswerReason = 'no_relevant_chunks';
            confidence = 'low';
          } else {
            confidence = 'medium';
          }
          answerStream = singleTextStream(content, confidence, { ...usage });
          trace.stop_reason = documentSearchAttempted
            ? 'no_relevant_evidence_response'
            : 'direct_response';
        } else {
          emit(progress, { type: 'status_updated', status: 'verifying' });
          const assembled = await this.context_assembler.assemble({
            chunks: [...evidence],
            original_query: request.original_query,
            max_context_chars: request.options.runtime.max_context_chars,
          });
          answerStream = await this.answer_finalizer.finalize(
            rewrittenQuery,
            content,
            assembled,
            request.options.require_citation,
            request.options.runtime.allow_verifier_correction,
            { ...usage },
          );
          trace.stop_reason = 'grounded_response';
        }
        break;
      }

      emptyResponses += 1;
      if (emptyResponses > 1) {
        throw new Error('agent model returned neither content nor tool calls twice');
      }
      messages.push(
        agentUserMessage('Your previous turn was empty. Reply now, or call one available tool.'),
      );
    }

    if (answerStream === null) {
      trace.stop_reason = 'react_budget_exhausted';
      noAnswerReason = 'no_relevant_chunks';
      answerStream = singleTextStream(
        '已达到本次处理步骤上限，暂时无法可靠完成这个问题。',
        'low',
        { ...usage },
      );
    }
    trace.mode = mode;
    trace.rewritten_query = rewrittenQuery;
    trace.retrieval_plan = plan;
    trace.usage = usage;
    return buildRun(
      prepared,
      mode,
      rewrittenQuery,
      trace,
      plan,
      retrievalTraces,
      answerStream,
      noAnswerReason,
    );
  }

  private async completeModel(
    request: AgentModelRequest,
    progress: ProgressSender,
  ): Promise<AgentModelResponse> {
    if (progress === null) {
      return this.model.complete(request);
    }
    const response = await this.model.completeStreamed(request, (event) => {
      if (event.type === 'response_delta') {
        emit(progress, { type: 'response_delta', delta: event.delta });
      } else {
        emit(progress, { type: 'thinking_delta', delta: event.delta });
      }
    });
    await new Promise<void>((resolve) => {
      emit(progress, { type: 'flush', acknowledgement: () => resolve() });
    });
    return response;
  }
}

function emitToolFailure(
  progress: ProgressSender,
  toolCallId: string,
  name: string,
  error: unknown,
): void {
  const event: AgentProgress = {
    type: 'tool_call_failed',
    tool_call_id: toolCallId,
    name: name,
    error: error,
  };
  emit(progress, event);
}
