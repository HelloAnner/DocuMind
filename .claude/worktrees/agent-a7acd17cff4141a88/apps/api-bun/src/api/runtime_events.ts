// 移植自 apps/api-rs/src/api/runtime_events.rs —— Atom SSE 事件协议
import { newUuid } from '../infra/uuid.ts';
import { nowRfc3339 } from '../infra/time.ts';

export const EVENT_PROTOCOL_HEADER = 'x-documind-event-protocol';
export const ATOM_SCHEMA_VERSION = 'moss.execution.event.v1';

export type SseProtocol = 'legacy' | 'atom';

export function sseProtocolFromHeaders(headers: Headers): SseProtocol {
  const requested = headers.get(EVENT_PROTOCOL_HEADER)?.trim();
  return requested === 'atom' || requested === ATOM_SCHEMA_VERSION ? 'atom' : 'legacy';
}

export interface RuntimeStep {
  step_id: string; parent_step_id: string | null;
  step_type: string; name: string;
}

export interface RuntimeEventEnvelope {
  schema_version: string; event_id: string; job_id: string; tenant_id: string;
  user_id: string; agent_id: string; session_id: string; execution_id: string;
  event_seq: number; event_type: string; occurred_at: string;
  response_message_id: string; trace_id: string;
  step: RuntimeStep | null; payload: unknown;
}

export interface SseEvent { event: string; id: string; data: string; }

export class RuntimeEventFactory {
  private readonly jobId: string;
  private readonly tenantId: string;
  private readonly userId: string;
  private readonly sessionId: string;
  private readonly executionId: string;
  private readonly responseMessageId: string;
  private readonly traceId: string;
  private nextSeq = 1;

  constructor(tenantId: string, userId: string, sessionId: string, responseMessageId: string) {
    this.jobId = newUuid();
    this.tenantId = tenantId;
    this.userId = userId;
    this.sessionId = sessionId;
    this.executionId = newUuid();
    this.responseMessageId = responseMessageId;
    this.traceId = `trace_${this.jobId}`;
  }

  event(eventType: string, payload: unknown): SseEvent {
    return this.eventWithStep(eventType, null, payload);
  }

  eventWithStep(eventType: string, step: RuntimeStep | null, payload: unknown): SseEvent {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const envelope: RuntimeEventEnvelope = {
      schema_version: ATOM_SCHEMA_VERSION,
      event_id: `evt_${this.jobId.replace(/-/g, '')}_${seq}`,
      job_id: this.jobId, tenant_id: this.tenantId, user_id: this.userId,
      agent_id: 'documind_default', session_id: this.sessionId,
      execution_id: this.executionId, event_seq: seq, event_type: eventType,
      occurred_at: nowRfc3339(), response_message_id: this.responseMessageId,
      trace_id: this.traceId, step, payload,
    };
    return { event: eventType, id: envelope.event_id, data: JSON.stringify(envelope) };
  }
}

export function toolStep(toolCallId: string, name: string): RuntimeStep {
  return {
    step_id: toolCallId, parent_step_id: null, step_type: 'ToolCall', name,
  };
}
