import { ApiClient } from "./api.ts";
import { ApiError, CliError } from "./errors.ts";
import { readSse } from "./sse.ts";
import type {
  ChatRequest,
  ChatRunReport,
  Citation,
  ExecutionRound,
  Identity,
  JsonObject,
  Message,
  MessageTraceResponse,
  ObservedEvent,
  RuntimeEventEnvelope,
  SseFrame,
} from "./types.ts";

export interface ChatObserver {
  onEvent?(event: ObservedEvent): void;
  onDelta?(text: string): void;
}

export class ChatService {
  constructor(private readonly api: ApiClient) {}

  async createConversation(kbIds: string[], title?: string): Promise<string> {
    const conversation = await this.api.createConversation(kbIds, title);
    await this.api.saveLastConversation(conversation.conversation_id);
    return conversation.conversation_id;
  }

  async send(request: ChatRequest, observer: ChatObserver = {}): Promise<ChatRunReport> {
    const identity = await this.api.me();
    const kbIds = request.kb_ids ?? this.api.config.chat.kb_ids;
    ensureKbScope(identity, kbIds);
    const conversationId = request.conversation_id ??
      await this.createConversation(kbIds, request.title);
    const clientRequestId = request.client_request_id ?? `cli_${crypto.randomUUID()}`;
    await this.api.saveLastConversation(conversationId);

    const started = performance.now();
    const startedAt = new Date();
    const response = await this.api.sse(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        content: request.content,
        kb_ids: kbIds,
        client_request_id: clientRequestId,
        stream: true,
      },
    );

    const events: ObservedEvent[] = [];
    let streamedContent = "";
    let firstEventMs: number | undefined;
    let firstTokenMs: number | undefined;
    let assistantMessageId = "";
    let userMessageId: string | undefined;
    let usage: JsonObject | undefined;
    let failure: unknown;

    for await (const frame of readSse(response)) {
      const elapsedMs = Math.max(0, Math.round(performance.now() - started));
      firstEventMs ??= elapsedMs;
      const envelope = runtimeEnvelope(frame);
      const observed: ObservedEvent = {
        ...frame,
        received_at: new Date().toISOString(),
        elapsed_ms: elapsedMs,
        ...(envelope ? { envelope } : {}),
      };
      events.push(observed);
      if (envelope) {
        assistantMessageId ||= envelope.response_message_id;
        if (envelope.event_type === "execution.started") {
          const candidate = envelope.payload.user_message_id;
          if (typeof candidate === "string") userMessageId = candidate;
        }
        if (envelope.event_type === "response.delta") {
          const delta = envelope.payload.delta;
          if (typeof delta === "string") {
            firstTokenMs ??= elapsedMs;
            streamedContent += delta;
            observer.onDelta?.(delta);
          }
        }
        if (envelope.event_type === "usage.reported") usage = envelope.payload;
        if (envelope.event_type === "execution.failed") failure = envelope.payload.error;
      } else {
        const legacy = legacyPayload(frame);
        if (frame.event === "message.created") {
          if (typeof legacy.assistant_message_id === "string") {
            assistantMessageId = legacy.assistant_message_id;
          }
          if (typeof legacy.user_message_id === "string") userMessageId = legacy.user_message_id;
        }
        if (frame.event === "answer.delta" && typeof legacy.text === "string") {
          firstTokenMs ??= elapsedMs;
          streamedContent += legacy.text;
          observer.onDelta?.(legacy.text);
        }
        if (frame.event === "answer.failed") failure = legacy;
      }
      observer.onEvent?.(observed);
    }

    if (!assistantMessageId) {
      throw new CliError("SSE 已结束，但没有返回 assistant_message_id", 1, events);
    }

    const messages = await this.api.getMessages(conversationId);
    const persisted = messages.messages.find((message) => message.message_id === assistantMessageId);
    if (!persisted) {
      throw new CliError(`消息 ${assistantMessageId} 未在会话落库结果中找到`, 1, messages);
    }
    let trace: MessageTraceResponse;
    try {
      trace = await this.api.getMessageTrace(conversationId, assistantMessageId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      trace = { message_id: assistantMessageId, retrieval_traces: [] };
    }

    const completed = performance.now();
    const citations = mergeCitations(persisted.citations, events);
    const rounds = executionRounds(events);
    const firstEnvelope = events.find((event) => event.envelope)?.envelope;
    const databaseDuration = persistedDuration(persisted);
    const report: ChatRunReport = {
      schema_version: "documind.cli.chat.v1",
      server: this.api.baseUrl,
      identity: {
        user_id: identity.user.id,
        username: identity.user.email,
        tenant_id: identity.tenant.id,
        tenant: identity.tenant.slug,
      },
      request: {
        conversation_id: conversationId,
        content: request.content,
        kb_ids: kbIds,
        client_request_id: clientRequestId,
      },
      response: {
        ...(userMessageId ? { user_message_id: userMessageId } : {}),
        assistant_message_id: assistantMessageId,
        content: persisted.content || streamedContent,
        status: persisted.status,
        ...(persisted.confidence ? { confidence: persisted.confidence } : {}),
        ...(persisted.no_answer_reason ? { no_answer_reason: persisted.no_answer_reason } : {}),
      },
      timing: {
        total_ms: Math.max(0, Math.round(completed - started)),
        ...(firstEventMs !== undefined ? { time_to_first_event_ms: firstEventMs } : {}),
        ...(firstTokenMs !== undefined ? { time_to_first_token_ms: firstTokenMs } : {}),
        ...(databaseDuration !== undefined
          ? { persisted_duration_ms: databaseDuration }
          : {}),
      },
      execution: {
        ...(firstEnvelope?.job_id ? { job_id: firstEnvelope.job_id } : {}),
        ...(firstEnvelope?.execution_id ? { execution_id: firstEnvelope.execution_id } : {}),
        ...(firstEnvelope?.trace_id ? { trace_id: firstEnvelope.trace_id } : {}),
        round_source: events.some((event) => event.envelope?.event_type.startsWith("agent.iteration."))
          ? "agent_iterations"
          : "runtime_tool_events",
        react_round_count: rounds.length,
        react_rounds: rounds,
        ...(usage ? { usage } : {}),
      },
      citations,
      trace,
      events,
    };

    if (failure || persisted.status === "failed") {
      throw new CliError("真实对话执行失败", 1, { failure, report });
    }
    return report;
  }
}

function ensureKbScope(identity: Identity, kbIds: string[]): void {
  const denied = kbIds.filter((id) => !identity.allowed_kb_ids.includes(id));
  if (denied.length > 0) {
    throw new CliError(`当前用户无权访问知识库: ${denied.join(", ")}`, 2);
  }
}

function runtimeEnvelope(frame: SseFrame): RuntimeEventEnvelope | undefined {
  if (!frame.data || typeof frame.data !== "object") return undefined;
  const value = frame.data as Record<string, unknown>;
  if (typeof value.schema_version !== "string" ||
      typeof value.event_type !== "string" ||
      typeof value.response_message_id !== "string" ||
      !value.payload || typeof value.payload !== "object") return undefined;
  return value as unknown as RuntimeEventEnvelope;
}

function legacyPayload(frame: SseFrame): Record<string, unknown> {
  return frame.data && typeof frame.data === "object"
    ? frame.data as Record<string, unknown>
    : {};
}

export function executionRounds(events: ObservedEvent[]): ExecutionRound[] {
  const rounds = new Map<string, ExecutionRound>();
  const order: string[] = [];
  for (const event of events) {
    const envelope = event.envelope;
    if (!envelope) continue;
    const payload = envelope.payload;
    const explicitId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : undefined;
    const iterationId = typeof payload.iteration_id === "string" ? payload.iteration_id : undefined;
    const id = explicitId ?? iterationId ?? envelope.step?.step_id;
    const isStart = envelope.event_type === "tool.call.started" ||
      envelope.event_type === "agent.iteration.started";
    const isResult = envelope.event_type === "tool.call.result" ||
      envelope.event_type === "agent.iteration.completed" ||
      envelope.event_type === "tool.call.failed";
    if (!id || (!isStart && !isResult)) continue;
    let round = rounds.get(id);
    if (!round) {
      order.push(id);
      round = {
        round: order.length,
        tool_call_id: id,
        name: typeof payload.name === "string" ? payload.name : envelope.step?.name ?? id,
        status: "running",
      };
      rounds.set(id, round);
    }
    if (isStart) {
      round.started_at ??= envelope.occurred_at || event.received_at;
      if (payload.arguments !== undefined) round.arguments = payload.arguments;
    }
    if (isResult) {
      round.completed_at = envelope.occurred_at || event.received_at;
      round.status = envelope.event_type === "tool.call.failed" || payload.status === "failed"
        ? "failed"
        : "succeeded";
      if (payload.result !== undefined) round.result = payload.result;
    }
  }

  const lastEventAt = events.at(-1)?.envelope?.occurred_at ?? events.at(-1)?.received_at;
  for (const round of rounds.values()) {
    if (round.status === "running" && round.tool_call_id === "answer_generation" && lastEventAt) {
      round.status = "succeeded";
      round.completed_at = lastEventAt;
    }
    if (round.started_at && round.completed_at) {
      const duration = Date.parse(round.completed_at) - Date.parse(round.started_at);
      if (Number.isFinite(duration) && duration >= 0) round.duration_ms = duration;
    }
  }
  return order.map((id) => rounds.get(id)).filter((item): item is ExecutionRound => Boolean(item));
}

function mergeCitations(persisted: Citation[], events: ObservedEvent[]): Citation[] {
  const streamed = new Map<string, Citation>();
  for (const event of events) {
    const envelope = event.envelope;
    if (envelope?.event_type !== "sources.reported") continue;
    const sources = envelope.payload.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      const citation = (source as Record<string, unknown>).documind_citation;
      if (!citation || typeof citation !== "object") continue;
      const value = citation as Citation;
      if (value.chunk_id) streamed.set(value.chunk_id, value);
    }
  }
  return persisted.map((citation) => ({ ...streamed.get(citation.chunk_id), ...citation }));
}

function persistedDuration(message: Message): number | undefined {
  if (!message.completed_at) return undefined;
  const duration = Date.parse(message.completed_at) - Date.parse(message.created_at);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
