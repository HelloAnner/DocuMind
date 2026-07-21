import { describe, expect, test } from "bun:test";
import { evaluateExpectations } from "../src/scenario.ts";
import type { ChatRunReport } from "../src/types.ts";

describe("scenario expectations", () => {
  test("checks answer quality, evidence and timing", () => {
    const assertions = evaluateExpectations(report(), {
      status: "completed",
      confidence: ["high", "medium"],
      citations_min: 1,
      retrievals_min: 2,
      react_rounds_min: 3,
      contains: "30 天",
      not_contains: "不知道",
      max_duration_ms: 10_000,
    });
    expect(assertions).toHaveLength(8);
    expect(assertions.every((item) => item.passed)).toBe(true);
  });
});

function report(): ChatRunReport {
  return {
    schema_version: "documind.cli.chat.v1",
    server: "http://server:8089",
    identity: { user_id: "u", username: "Anner", tenant_id: "t", tenant: "acme" },
    request: {
      conversation_id: "c",
      content: "付款期限？",
      kb_ids: ["kb"],
      client_request_id: "r",
    },
    response: {
      assistant_message_id: "a",
      content: "付款期限为 30 天。",
      status: "completed",
      confidence: "high",
    },
    timing: { total_ms: 9000 },
    execution: {
      round_source: "runtime_tool_events",
      react_round_count: 4,
      react_rounds: [],
    },
    citations: [{
      index: 1,
      doc_id: "d",
      chunk_id: "chunk",
      doc_title: "合同",
      page_range: [1],
      quote: "30 天",
    }],
    trace: {
      message_id: "a",
      retrieval_traces: [
        { id: "1", message_id: "m", chunk_id: "1", doc_id: "d", source: "dense", rank: 1, score: 1, heading_path: [], page_range: [], content_preview: "a" },
        { id: "2", message_id: "m", chunk_id: "2", doc_id: "d", source: "rerank", rank: 1, score: 1, heading_path: [], page_range: [], content_preview: "b" },
      ],
    },
    events: [],
  };
}
