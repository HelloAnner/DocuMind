import { describe, expect, test } from "bun:test";
import { executionRounds } from "../src/chat.ts";
import type { ObservedEvent, RuntimeEventEnvelope } from "../src/types.ts";

describe("executionRounds", () => {
  test("normalizes tool events into ordered ReAct rounds with durations", () => {
    const events = [
      event("tool.call.started", "2026-07-21T00:00:00.000Z", {
        tool_call_id: "query_rewrite",
        name: "query_rewrite",
        arguments: { stage: "rewriting" },
      }),
      event("tool.call.result", "2026-07-21T00:00:00.125Z", {
        tool_call_id: "query_rewrite",
        name: "query_rewrite",
        status: "succeeded",
        result: "rewritten",
      }),
      event("tool.call.started", "2026-07-21T00:00:00.200Z", {
        tool_call_id: "answer_generation",
        name: "answer_generation",
      }),
      event("execution.completed", "2026-07-21T00:00:01.000Z", {}),
    ];
    expect(executionRounds(events)).toEqual([
      expect.objectContaining({
        round: 1,
        tool_call_id: "query_rewrite",
        status: "succeeded",
        duration_ms: 125,
        result: "rewritten",
      }),
      expect.objectContaining({
        round: 2,
        tool_call_id: "answer_generation",
        status: "succeeded",
        duration_ms: 800,
      }),
    ]);
  });
});

function event(
  eventType: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): ObservedEvent {
  const envelope: RuntimeEventEnvelope = {
    schema_version: "moss.execution.event.v1",
    event_id: crypto.randomUUID(),
    job_id: "job",
    tenant_id: "tenant",
    user_id: "user",
    agent_id: "agent",
    session_id: "session",
    execution_id: "execution",
    event_seq: 1,
    event_type: eventType,
    occurred_at: occurredAt,
    response_message_id: "message",
    trace_id: "trace",
    payload,
  };
  return {
    event: eventType,
    data: envelope,
    envelope,
    received_at: occurredAt,
    elapsed_ms: 0,
  };
}
